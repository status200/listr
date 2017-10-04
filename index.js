'use strict';
const Task = require('./lib/task');
const TaskWrapper = require('./lib/task-wrapper');
const renderer = require('./lib/renderer');
const ListrError = require('./lib/listr-error');

const runTask = (task, context, errors) => {
	if (!task.isEnabled()) {
		return Promise.resolve();
	}

	return new TaskWrapper(task, errors).run(context);
};

class Listr {

	constructor(tasks, opts) {
		if (tasks && !Array.isArray(tasks) && typeof tasks === 'object') {
			if (typeof tasks.title === 'string' && typeof tasks.task === 'function') {
				throw new TypeError('Expected an array of tasks or an options object, got a task object');
			}

			opts = tasks;
			tasks = [];
		}

		if (tasks && !Array.isArray(tasks)) {
			throw new TypeError('Expected an array of tasks');
		}

		this._options = Object.assign({
			showSubtasks: true,
			concurrent: false,
			renderer: 'default',
			nonTTYRenderer: 'verbose'
		}, opts);
		this._tasks = [];

		this.concurrency = 1;
		if (this._options.concurrent === true) {
			this.concurrency = Infinity;
		} else if (typeof this._options.concurrent === 'number') {
			this.concurrency = this._options.concurrent;
		}

		this._RendererClass = renderer.getRenderer(this._options.renderer, this._options.nonTTYRenderer);

		this.exitOnError = this._options.exitOnError;

		this.add(tasks || []);
	}

	_checkAll(context) {
		for (const task of this._tasks) {
			task.check(context);
		}
	}

	get tasks() {
		return this._tasks;
	}

	setRenderer(value) {
		this._RendererClass = renderer.getRenderer(value);
	}

	add(task) {
		const tasks = Array.isArray(task) ? task : [task];

		for (const task of tasks) {
			this._tasks.push(new Task(this, task, this._options));
		}

		return this;
	}

	addDynamic(task) {
		if (this._addDynamic === undefined) {
			throw new Error('`addDynamic` method only available while the list is running');
		}
		const tasks = Array.isArray(task) ? task : [task];
		for (const task of tasks) {
			this._addDynamic(task);
		}
		return this;
	}

	render() {
		if (!this._renderer) {
			this._renderer = new this._RendererClass(this._tasks, this._options);
		}

		return this._renderer.render();
	}

	run(context) {
		this.render();

		context = context || Object.create(null);

		const errors = [];

		this._checkAll(context);

		const runner = new Promise((resolve, reject) => {
			const results = [];
			const taskList = {};
			const taskState = {};
			this._tasks.forEach((task, i) => {
				const symbol = Symbol(`task_${i}`);
				taskList[symbol] = i;
				taskState[symbol] = 0;
			});
			const waiting = () => {
				return Object.getOwnPropertySymbols(taskState).filter(key => {
					return taskState[key] === 0;
				});
			};
			const inProgress = () => {
				return Object.getOwnPropertySymbols(taskState).filter(key => {
					return taskState[key] === 1;
				});
			};
			const done = () => {
				return Object.getOwnPropertySymbols(taskState).filter(key => {
					return taskState[key] === 2;
				});
			};
			const execute = () => {
				let limit = this.concurrency;
				if (this.concurrency === Infinity) {
					limit = Infinity;
				}
				for (let i = inProgress().length; i < limit; i++) {
					const nextSymbol = waiting()[0];
					if (nextSymbol === undefined) {
						if (Object.getOwnPropertySymbols(taskList).length === done().length) {
							delete this._addDynamic;
							return resolve(results);
						}
						break;
					}
					taskState[nextSymbol] = 1;
					this._checkAll(context);
					runTask(this._tasks[taskList[nextSymbol]], context, errors).then(result => {
						results.push(result);
						taskState[nextSymbol] = 2;
						execute();
					}).catch(reject);
				}
			};
			execute();
			this._addDynamic = task => {
				this.add(task);
				const position = this._tasks.length - 1;
				const symbol = Symbol(`task_${position}`);
				taskList[symbol] = position;
				taskState[symbol] = 0;
				execute();
			};
		});

		return runner
			.then(() => {
				if (errors.length > 0) {
					const err = new ListrError('Something went wrong');
					err.errors = errors;
					throw err;
				}

				this._renderer.end();

				return context;
			})
			.catch(err => {
				err.context = context;
				this._renderer.end(err);
				throw err;
			});
	}
}

module.exports = Listr;
