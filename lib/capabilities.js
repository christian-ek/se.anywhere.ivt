'use strict';

module.exports = {
  SUPPLY_TEMP: {
    name: 'measure_temperature.supply',
    endpoint: '/heatSources/actualSupplyTemperature',
  },
  RETURN_TEMP: {
    name: 'measure_temperature.return',
    endpoint: '/heatSources/returnTemperature',
  },
  OUTDOOR_TEMP: {
    name: 'measure_temperature.outdoor',
    endpoint: '/system/sensors/temperatures/outdoor_t1',
  },
  WATER_TEMP: {
    name: 'measure_temperature.water',
    endpoint: '/dhwCircuits/dhw1/actualTemp',
  },
  HEALTH_STATUS: {
    name: 'alarm_status',
    endpoint: '/system/healthStatus',
  },
};
