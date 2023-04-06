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

    await this.registerFlowCards();

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
    if (capability === 'health_status') {
      if (this.getCapabilityValue(capability) !== value) {
        // health_status has changed. Trigger card.
        this.triggerHealthStatusChange(value);
      }
    }
    this.log(`Setting capability [${capability}] value to: ${value}`);
    this.setCapabilityValue(capability, value).catch(this.error);
  }

  async triggerHealthStatusChange(value) {
    const tokens = {
      code: null,
      description: null,
    };

    if (value !== 'ok') {
      await this.client.get('/notifications')
        .then((res) => {
          if (res.values.size > 0) {
            tokens.code = res.values.map((obj) => obj.ccd).join(', ');
            tokens.description += res.values.map((obj) => ErrorCodes[obj.ccd].description).join(', ');
          }
        })
        .catch((err) => this.log(err));
    }

    this.healthStatusChangedCard.trigger(tokens)
      .then(this.log)
      .catch(this.error);
  }

  async registerFlowCards() {
    this.healthStatusChangedCard = await this.homey.flow.getTriggerCard('health_status_changed');
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
    const {
      interval,
      device,
    } = this;
    this.log(`${device.name} deleted`);
    if (this.client) {
      this.client.end();
    }
    await this.homey.flow.unregisterToken(this.errorCodeToken);
    await this.homey.flow.unregisterToken(this.errorTextToken);

    clearInterval(interval);
  }

}

module.exports = HeatPumpDevice;
