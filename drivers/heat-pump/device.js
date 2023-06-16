'use strict';

const { Device } = require('homey');
const { IVTClient } = require('../../lib/bosch-xmpp');
const Capabilities = require('../../lib/capabilities');
const ErrorCodes = require('../../lib/errorcodes');

class HeatPumpDevice extends Device {

  async onInit() {
    try {
      this.client = await this.getClient(this.getSettings());
    } catch (e) {
      this.log(`Unable to initialize device: ${e.message}`);
      throw e;
    }

    const updateInterval = Number(this.getSetting('interval')) * 1000;
    this.data = this.getData();

    this.log(`[${this.getName()}][${this.data.id}]`, `Update Interval: ${updateInterval}`);
    this.log(`[${this.getName()}][${this.data.id}]`, 'Connected to device');
    this.interval = setInterval(async () => {
      await this.getDeviceData();
    }, updateInterval);

    this.log('IVT heat pump device has been initialized');
  }

  async getDeviceData() {
    const energyMonitoringCapabilities = [
      'LAST_HOUR_POWER_TOTAL',
      'LAST_HOUR_POWER_EHEATER',
      'LAST_HOUR_POWER_COMPRESSOR',
    ];

    this.log(`[${this.getName()}][${this.data.id}]`, 'Refreshing device data');

    for (const [key, value] of Object.entries(Capabilities)) {
      try {
        let result;
        // Add the date to energy monitoring capabilites endpoints
        const endpoint = energyMonitoringCapabilities.includes(key)
          ? value.endpoint + new Date().toISOString().split('T')[0]
          : value.endpoint;

        // Get data from heat pump
        const res = await this.client.get(endpoint);

        if (energyMonitoringCapabilities.includes(key)) {
          const currentHour = new Date().getHours();

          // subtract 2 to account for array being zero based and to get last hours measurement
          const currentHourObject = res.recording[currentHour - 2];

          result = currentHourObject.y / currentHourObject.c;
        } else {
          result = res.value;
        }

        this.updateValue(value.name, result);
      } catch (err) {
        this.log(err);
      }
    }
  }

  updateValue(capability, value) {
    if (capability === 'alarm_status') {
      value = value !== 'ok';
      if (this.getCapabilityValue(capability) !== value) {
        this.triggerAlarmStatusChange(value);
      }
    }

    this.log(`Setting capability [${capability}] value to: ${value}`);
    this.setCapabilityValue(capability, value).catch(this.error);
  }

  async triggerAlarmStatusChange(value) {
    if (value) {
      try {
        const res = await this.client.get('/notifications');
        const tokens = {
          code: res.values.map((obj) => obj.ccd).join(', '),
          description: res.values
            .map((obj) => `${obj.ccd}: ${ErrorCodes[obj.ccd].description}`)
            .join(', '),
        };

        this.log('Alarm status has changed to error. Trigger ERROR card..');
        this.log(`code: ${tokens.code}`);
        this.log(`description: ${tokens.description}`);

        await this.homey.flow.getDeviceTriggerCard('alarm_status_error')
          .trigger(this, tokens);
      } catch (error) {
        this.log(error);
      }
    } else if (this.getCapabilityValue('alarm_status') === 'error') {
      this.log('Alarm status has changed to OK. Trigger OK card.');
      this.homey.flow.getDeviceTriggerCard('alarm_status_ok').trigger(this)
        .catch(this.error);
    }
  }

  async onAdded() {
    this.log('Device added');
    this.log('Name:', this.getName());
    this.log('Class:', this.getClass());
    this.log('Data:', this.getData());
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const { interval } = this;
    for (const name of changedKeys) {
      if (name !== 'password') {
        this.log(`Setting '${name}' changed from '${oldSettings[name]}' to '${newSettings[name]}'`);
      }
    }
    if (oldSettings.interval !== newSettings.interval) {
      this.log(`Deleting old interval of ${oldSettings.interval}s and creating new ${newSettings.interval}s`);
      clearInterval(interval);
      this.setUpdateInterval(newSettings.interval);
    }
  }

  async getClient(settings) {
    const client = IVTClient({
      serialNumber: settings.serial,
      accessKey: settings.key,
      password: settings.password,
    });

    await client.connect();
    this.log('Device connected successfully to backend');

    return client;
  }

  async onRenamed(name) {
    this.log(`${name} renamed`);
  }

  async onDeleted() {
    const { interval } = this;
    this.log(`${this.data.id} deleted`);
    if (this.client) {
      this.client.end();
    }

    clearInterval(interval);
  }

}

module.exports = HeatPumpDevice;
