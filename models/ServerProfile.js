module.exports = (sequelize, DataTypes) => {
  return sequelize.define('ServerProfile', {
    guildId: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false
    },
    guildName: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: ''
    },
    settingsJson: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '{}'
    }
  });
};