module.exports = function (sequelize, DataTypes) {
  const _securitytradingstatus_history = sequelize.define(
    "_securitytradingstatus_history",
    {
      id: {
        autoIncrement: true,
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
      Symbol: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      MDSubOrderBookType: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      OpeningPrice: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      ClosingPrice: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      HighPrice: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      LowPrice: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      VWAP: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      Volume: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      HighestBidPrice: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      LowestOfferPrice: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      PreviousClose: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      BuyOrderQty: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      SellOrderQty: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      Turnover: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      Trades: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      MDEntryTime: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      companycode: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      MarketSegmentID: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      securityType: {
        type: DataTypes.STRING(),
        allowNull: false,
      },
      dates: {
        type: DataTypes.DATE(),
        allowNull: false,
      },
    },
    {
      charset: "utf8",
      collate: "utf8_general_ci",
      sequelize,
      tableName: "_securitytradingstatus_history",
      timestamps: false,
      indexes: [
        {
          name: "PRIMARY",
          unique: true,
          using: "BTREE",
          fields: [{ name: "id" }],
        },
      ],
    }
  );

  _securitytradingstatus_history.associate = function (models) {};

  return _securitytradingstatus_history;
};
