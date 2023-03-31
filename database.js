const { Sequelize, DataTypes, Model, Op } = require("sequelize");
const sequelize = new Sequelize("database", "username", "password", {
	dialect: "sqlite",
	storage: "cache.sqlite",
	logging: false,
});

const Cache = sequelize.define(
	"Cache",
	{
		id: {
			type: Sequelize.INTEGER,
			autoIncrement: false,
			primaryKey: true,
		},
		roSub: {
			type: Sequelize.BOOLEAN,
		},
		resolution: {
			type: DataTypes.STRING,
		},
	},
	{
		indexes: [
			{
				unique: true,
				fields: ["id"],
			},
		],
	}
);

Cache === sequelize.models.Cache;

Cache.findByIds = function (ids) {
	const conditions = [];
	ids.forEach((id) => conditions.push({ id: id }));

	return this.findAll({
		where: {
			[Op.or]: conditions,
		},
		raw: true,
	});
};

module.exports = {
	Cache,
	sequelize,
};
