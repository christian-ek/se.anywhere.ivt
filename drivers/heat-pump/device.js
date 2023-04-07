'use strict';

const { Device } = require('homey');
const { IVTClient } = require('../../lib/bosch-xmpp');
const Capabilities = require('../../lib/capabilities');
const ErrorCodes = require('../../lib/errorcodes');

class HeatPumpDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    try {
      this.client = await this.getClient(this.getSettings());
    } catch (e) {
      this.log(`unable to initialize device: ${e.message}`);
      throw e;
    }

    this.device = this.getData();

    const updateInterval = Number(this.getSetting('interval')) * 1000;
    const { device } = this;
    this.log(`[${this.getName()}][${device.id}]`, `Update Interval: ${updateInterval}`);
    this.log(`[${this.getName()}][${device.id}]`, 'Connected to device');
    this.interval = setInterval(async () => {
      await this.getDeviceData();
    }, updateInterval);

    this.log('IVT heat pump device has been initialized');
  }

  async getDeviceData() {
    const { device } = this;
    this.log(`[${this.getName()}][${device.id}]`, 'Refresh device');

    for (const value of Object.values(Capabilities)) {
      await this.client.get(value.endpoint)
        .then((res) => {
          this.updateValue(value.name, res.value);
        })
        .catch((err) => this.log(err));
    }
  }

  updateValue(capability, value) {
    if (capability === 'alarm_status') {
      if (value === 'ok') {
        value = false;
      } else {
        // Activate alarm
        value = true;
      }

      if (this.getCapabilityValue(capability) !== value) {
        this.triggerAlarmStatusChange(value);
      }
    }

    this.log(`Setting capability [${capability}] value to: ${value}`);
    this.setCapabilityValue(capability, value).catch(this.error);
  }

  async triggerAlarmStatusChange(value) {
    if (value) {
      this.log('Alarm status has changed to error. Trigger ERROR card..');
      await this.client.get('/notifications')
        .then((res) => {
          const tokens = {
            code: res.values.map((obj) => obj.ccd).join(', '),
            description: res.values.map((obj) => {
              return `${obj.ccd}: ${ErrorCodes[obj.ccd].description}`;
            }).join(', '),
          };

          return tokens;
        })
        .then(async (tokens) => {
          this.log(`code: ${tokens.code}`);
          this.log(`description: ${tokens.description}`);
          this.homey.flow.getTriggerCard('alarm_status_error').trigger(tokens).then(this.log).catch(this.error);
        })
        .catch(this.error);
    } else {
      this.log('Alarm status has changed to OK. Trigger OK card.');
      this.homey.flow.getTriggerCard('alarm_status_ok').trigger().then(this.log).catch(this.error);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('device added');
    this.log('name:', this.getName());
    this.log('class:', this.getClass());
    this.log('data', this.getData());
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }) {
    const { interval } = this;
    for (const name of changedKeys) {
      /* Log setting changes except for password */
      if (name !== 'password') {
        this.log(`Setting '${name}' set '${oldSettings[name]}' => '${newSettings[name]}'`);
      }
    }
    if (oldSettings.interval !== newSettings.interval) {
      this.log(`Delete old interval of ${oldSettings.interval}s and creating new ${newSettings.interval}s`);
      clearInterval(interval);
      this.setUpdateInterval(newSettings.interval);
    }
  }

  // Get a (connected) instance of the Nefit Easy client.
  async getClient(settings) {
    const client = IVTClient({
      serialNumber: settings.serial,
      accessKey: settings.key,
      password: settings.password,
    });
    await client.connect()
      .then(this.log('device connected successfully to backend'));

    return client;
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log(`${name} renamed`);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    const { interval, device } = this;
    this.log(`${device.id} deleted`);
    if (this.client) {
      this.client.end();
    }

    clearInterval(interval);
  }

}

module.exports = HeatPumpDevice;
