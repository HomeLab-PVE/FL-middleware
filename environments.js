const protocol = "https";
const envs = {
	baseUrl: protocol + "://" + process.env.FL_DOMAIN,
	secondaryUrl: process.env.FL_DOMAIN_SECONDARY ? protocol + "://" + process.env.FL_DOMAIN_SECONDARY : null,
	user: process.env.FL_USER,
	userPass: process.env.FL_PASS,
	passkey: process.env.FL_PASSKEY,
	headless: process.env.HEADLESS == "true" ? true : false,
	clusterMonitor: process.env.CLUSTER_MONITOR == "true" ? true : false,
	roSubTag: process.env.RO_SUB_TAG ? process.env.RO_SUB_TAG : "RO-SUB",
	serverBindIp: process.env.SERVER_IP_BIND ? process.env.SERVER_IP_BIND : "0.0.0.0",
	serverPort: process.env.SERVER_PORT ? process.env.SERVER_PORT : 3998,
	workers: process.env.WORKERS ? parseInt(process.env.WORKERS) : 5,
};

module.exports = envs;
