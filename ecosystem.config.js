module.exports = {
	apps : [{
		name: "FL-middleware",
		script: "./index.js",
		watch: false,
		exec_mode: "fork",
		autorestart: true,
		restart_delay: 4000,
		max_restarts: 10,
	}]
}