'use strict';

module.exports = {
  // --- NEW: Map standard measure_temperature to Room Temperature ---
  ROOM_TEMP: {
    name: 'measure_temperature',
    endpoint: '/heatingCircuits/hc1/roomtemperature',
  },
  // -----------------------------------------------------------------
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
  PUMP_MODULATION: {
    name: 'pump_modulation',
    endpoint: '/heatingCircuits/hc1/pumpModulation',
  },
  DHW_SETPOINT: {
    name: 'measure_temperature.water_setpoint',
    endpoint: '/dhwCircuits/dhw1/currentSetpoint',
  },
};
