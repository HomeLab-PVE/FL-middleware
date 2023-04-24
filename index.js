require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const { Cluster } = require("puppeteer-cluster");
const { Cache, sequelize } = require(path.resolve(__dirname, "./database"));
const puppeteer = require("puppeteer");
const schedule = require("node-schedule");
const https = require("https");
const envs = require("./environments");
const app = express();
const sessions = {};

const middleware = createProxyMiddleware({
	target: envs.baseUrl,
	changeOrigin: true,
	selfHandleResponse: true,
	onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
		try {
			if (req.path !== "/api.php" && proxyRes.headers["content-type"] !== "application/json") {
				return responseBuffer;
			}
			const data = JSON.parse(responseBuffer.toString("utf8"));
			if (data && data.length) {
				const cachedData = await Cache.findByIds(Object.keys(data).map((key) => data[key].id));
				const newData = data.filter(({ id: newId }) => !cachedData.some(({ id: cachedId }) => newId === cachedId));
				const searchIds = Object.keys(newData).map((key) => newData[key].id);

				if (searchIds.length > 0) {
					const searchData = await find(searchIds);
					Array.prototype.push.apply(cachedData, searchData);
				}

				const response = data.map((api) => {
					const result = cachedData.find((element) => element.id === api.id);
					api["intercept"] = true;
					if (result && result.updatedAt) {
						api["middlewareCache"] = {
							updatedAt: result.updatedAt,
						};
					} else {
						api["middlewareCache"] = false;
					}
					if (api.category === "Filme HD-RO") {
						api.name = api.name + "." + envs.roSubTag;
					} else {
						if (result && result.roSub) {
							api.name = api.name + "." + envs.roSubTag;
						}
					}
					if (result && result.resolution) {
						api.name = api.name + "." + result.resolution;
					}
					return api;
				});

				return JSON.stringify(response);
			}

			return responseBuffer;
		} catch (err) {
			console.error("Error onProxyRes: ", err);
		}
	}),
	logger: console,
});

const find = async (ids) => {
	const cluster = await Cluster.launch({
		concurrency: Cluster.CONCURRENCY_PAGE,
		maxConcurrency: envs.workers,
		monitor: envs.clusterMonitor,
		workerCreationDelay: 5,
		sameDomainDelay: 50,
		timeout: 120000,
		puppeteerOptions: {
			headless: envs.headless,
			args: flags,
		},
	});

	await cluster.task(async ({ page, data }) => {
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			if (blockResourceType.indexOf(request.resourceType()) !== -1 || getHostname(request.url()) !== getHostname(data.url)) {
				request.abort();
			} else {
				request.continue();
			}
		});

		await setPreviousSession(page, data.url);
		await page.goto(data.url, { waitUntil: "domcontentloaded" });
		if (await page.url().includes("login.php")) {
			await login(page);
		}

		return analyze(page, data.id);
	});

	const results = [];

	try {
		ids.map((id) => {
			cluster
				.execute({
					url: domainsLoadBalancing() + "/details.php?id=" + id,
					id: id,
				})
				.then((result) => {
					if (result) {
						results.push(result);
					}
				});
		});
	} catch (err) {
		console.error(err);
	}

	await cluster.idle();
	await cluster.close();

	return results;
};

const login = async (page) => {
	try {
		const credentials = {
			username: envs.user,
			password: envs.userPass,
		};

		if ((await page.$("#username")) && (await page.$("#password"))) {
			for (const [key, value] of Object.entries(credentials)) {
				await page.click(`#${key}`);
				await page.type(`#${key}`, value);
			}
			await Promise.all([page.click('input[type=submit][value="Login"]'), page.waitForNavigation({ waitUntil: "networkidle2" })]);
		}

		if (!(await page.url().includes("login.php"))) {
			const cookies = await page.cookies();
			sessions[getHostname(page.url())] = cookies;
			await fs.promises.writeFile(
				path.resolve(__dirname, "./session/session_" + getHostname(page.url()) + ".json"),
				JSON.stringify(cookies, null, 2)
			);
			return true;
		}

		return false;
	} catch (err) {
		console.error("Login: ", err);
	}
};

const setPreviousSession = async (page, url) => {
	if (sessions && sessions[getHostname(url)]) {
		await page.setCookie(...sessions[getHostname(url)]);
		return;
	}
	const sesionPath = path.resolve(__dirname, "./session/session_" + getHostname(url) + ".json");
	if (!(await fileExists(sesionPath))) {
		return;
	}
	const session = JSON.parse(await fs.promises.readFile(sesionPath));
	if (session && Object.keys(session).length) {
		await page.setCookie(...session);
	}
};

const analyze = async (page, id) => {
	try {
		let description = [];
		const selectors = ["#descr", ".quote", "font[color=red]"];
		let result = {
			id: id,
		};

		for (let i = 0; i < selectors.length; i++) {
			if ((selector = await page.$(selectors[i], { timeout: 300 })) !== null) {
				description.push(await selector.evaluate((desc) => desc.textContent.toLowerCase()));
			}
		}
		
		description = description.join();
		
		if (description) {
			if ((subsMatch = description.match(/\b(romanian|rum|rom)\b/g))) {
				result["roSub"] = true;
			}
			if ((resolutionMatch = description.match(/\d+x\d+|\d+\sx\s\d+|\d+(\*+)\d+\spixels/g))) {
				result["resolution"] = resolutionMatch[0].replaceAll(" ", "").replaceAll("*", "x").replace("pixels", "");
			}
		} else {
			console.info("Description not found for id: " + id);
		}

		try {
			await Cache.create(result);
		} catch (error) {
			if (error.name !== "SequelizeUniqueConstraintError") {
				console.error("Error cache create: ", error);
			}
		}
		return result;
	} catch (err) {
		console.error("Analyze: ", err);
	}
};

const checkLogin = async (url) => {
	try {
		const browser = await puppeteer.launch({ 
			headless: envs.headless, 
			args: ['--no-sandbox', '--disable-setuid-sandbox'], 
		});
		const page = await browser.newPage();
		await setPreviousSession(page, url);
		await page.goto(url);
		if (!(await page.url().includes("login.php"))) {
			const cookies = await page.cookies();
			sessions[getHostname(url)] = cookies;
			await fs.promises.writeFile(path.resolve(__dirname, "./session/session_" + getHostname(url) + ".json"), JSON.stringify(cookies, null, 2));
			await browser.close();
			return true;
		} else {
			const status = await login(page);
			await browser.close();
			return status;
		}
	} catch (err) {
		console.error("Check login: ", err);
	}
};

const updateSessions = async () => {
	const baseSesions = await checkLogin(envs.baseUrl);
	if (envs.secondaryUrl) {
		await checkLogin(envs.secondaryUrl);
	}
	return baseSesions;
};

const getLatest = async (cat) => {
	const limit = 10;
	return new Promise((resolve, reject) => {
		https
			.get(
				`${envs.baseUrl}/api.php?username=${envs.user}&passkey=${envs.passkey}&action=latest-torrents&category=${cat}&limit=${limit}`,
				(res) => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						return reject(new Error("statusCode=" + res.statusCode));
					}
					let data = [];
					const headerDate = res.headers && res.headers.date ? res.headers.date : "no response date";
					res.on("data", (chunk) => {
						data.push(chunk);
					});
					res.on("end", () => {
						try {
							resolve(JSON.parse(Buffer.concat(data).toString()));
						} catch (e) {
							reject(e);
						}
					});
				}
			)
			.on("error", (err) => {
				console.log("Get latest: ", err.message);
				reject(err);
			});
	});
};

const fileExists = async (path) => !!(await fs.promises.stat(path).catch((e) => false));

const getHostname = (url) => {
	return new URL(url).hostname;
};

let actualDomain = 0;
const domainsLoadBalancing = () => {
	let domains = [envs.baseUrl];
	if (envs.secondaryUrl) {
		domains.push(envs.secondaryUrl);
	}
	actualDomain === domains.length - 1 ? (actualDomain = 0) : actualDomain++;
	return domains[actualDomain];
};

const catchFilePath = (id) => {
	return path.resolve(__dirname, "./cache/" + id + ".json");
};

const blockResourceType = ["beacon", "csp_report", "font", "image", "imageset", "media", "object", "texttrack", "iframe", "stylesheet", "script"];

const flags = [
	"--disable-gl-drawing-for-tests",
	"--disable-canvas-aa",
	"--disable-2d-canvas-clip-aa",
	"--disable-features=Translate,OptimizationHints,MediaRouter",
	"--disable-extensions",
	"--disable-component-extensions-with-background-pages",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-client-side-phishing-detection",
	"--disable-sync",
	"--metrics-recording-only",
	"--disable-default-apps",
	"--no-default-browser-check",
	"--no-first-run",
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--disable-background-timer-throttling",
	"--disable-ipc-flooding-protection",
	"--password-store=basic",
	"--use-mock-keychain",
	"--force-fieldtrials=*BackgroundTracing/default/",
	"--disable-gl-drawing-for-tests",
	"--disable-canvas-aa",
	"--disable-2d-canvas-clip-aa",
	"--no-sandbox",
	"--disable-setuid-sandbox",
];

const cronJobEnd = async (startDate, jobName) => {
	if (!startDate) {
		return;
	}
	return `Job end: ${jobName}. End date: ${new Date().toISOString()}.`;
};

(async function () {
	console.log("Booting...");
	console.log("Creating directories...");
	const sessionDir = path.resolve(__dirname, "./session");
	if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
	console.log("Database synchronization...");
	await sequelize.sync();
	console.log("Updating login sessions...");
	if (!(await updateSessions())) {
		console.log("The server cannot start until authentication is successful! Verify the user and password in the .env file and restart the proces.");
		process.exit(1);
	}
})().then(() => {
	app.use("/", middleware);
	const server = app.listen(envs.serverPort, envs.serverBindIp, () => {
		console.log(`Server is running on: ${envs.serverBindIp}:${envs.serverPort}`);
	});
	console.log("Scheduling job: update sessions");
	const updateSessionsCron = schedule.scheduleJob("0 */2 * * *", async () => {
		const startJob = new Date();
		console.info(`Job start: updating login sessions. Start date: ${startJob.toISOString()}`);
		await updateSessions();
		console.info(await cronJobEnd(startJob, 'updating login sessions'));
	});
	console.log("Scheduling job: update latest entries");
	const updateLatestCron = schedule.scheduleJob("*/25 * * * *", async () => {
		const startJob = new Date();
		console.info(`Job start: updating latest entries. Start date: ${startJob.toISOString()}`);
		try {
			const categories = [6, 26, 20, 4, 19, 1, 21, 27, 23];
			for (let i = 0; i < categories.length; i++) {
				await new Promise(r => setTimeout(r, 1000));
				console.log(`Getting latest entries from category: ${categories[i]}`);
				let latest = await getLatest(categories[i]);
				let cachedData = await Cache.findByIds(Object.keys(latest).map((key) => latest[key].id));
				let newData = latest.filter(({ id: newId }) => !cachedData.some(({ id: cachedId }) => newId === cachedId));
				let searchIds = Object.keys(newData).map((key) => newData[key].id);
				if (searchIds.length > 0) {
					await find(searchIds);
				}
			}
			console.info(await cronJobEnd(startJob, 'updating latest entries'));
		} catch (err) {
			console.error(err);
		}
	});
});
