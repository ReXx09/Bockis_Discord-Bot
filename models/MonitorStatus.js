module.exports = (sequelize, DataTypes) => {
  return sequelize.define('MonitorStatus', {
    monitorId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('up', 'down', 'unknown'),
      allowNull: false
    },
    responseTime: {
      type: DataTypes.INTEGER,
      comment: 'Response time in ms'
    }
  });
};
