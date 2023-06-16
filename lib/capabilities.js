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
  LAST_HOUR_POWER_TOTAL: {
    name: 'meter_power.last_hour_total',
    endpoint: '/recordings/heatSources/total/energyMonitoring/consumedEnergy?interval=',
  },
  LAST_HOUR_POWER_EHEATER: {
    name: 'meter_power.last_hour_eheater',
    endpoint: '/recordings/heatSources/total/energyMonitoring/eheater?interval=',
  },
  LAST_HOUR_POWER_COMPRESSOR: {
    name: 'meter_power.last_hour_compressor',
    endpoint: '/recordings/heatSources/total/energyMonitoring/compressor?interval=',
  },
};
