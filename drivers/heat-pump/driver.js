'use strict';

const Homey = require('homey');
const Device = require('./device');

class HeatPumpDriver extends Homey.Driver {

  // Pairing
  onPair(session) {
    this.log('Pairing started');
    session.setHandler('validate_device', async (data) => {
      const pairingDevice = {
        name: 'IVT Heat pump',
        data: {
          id: data.serial,
        },
        settings: {
          interval: data.interval,
          serial: data.serial,
          key: data.key,
          password: data.password,
        },
      };

      try {
        await this.validateDevice(pairingDevice);
        return pairingDevice;
      } catch (err) {
        this.log(`There was an error: ${err}`);
        return Promise.reject(err);
      }
    });
  }

  async validateDevice(data) {
    // Check and see if we can connect to the backend with the supplied credentials.
    let client;
    try {
      client = await Device.prototype.getClient.call(this, data.settings);
    } catch (e) {
      this.log('unable to instantiate client:', e.message);
      throw new Error(e);
    }

    let device;
    // Check for duplicate.
    try {
      device = this.getDevice(data.data);
    } catch (err) {
      // Device does not exist, hooray!
    }

    if (device instanceof Homey.Device) {
      this.log('device is already registered');
      client.end();
      throw new Error('Device is already registered');
    }

    // Retrieve status to see if we can successfully load data from backend.
    try {
      await client.get('/gateway/versionFirmware');
    } catch (e) {
      if (e instanceof SyntaxError) {
        this.log('invalid credentials');
        throw new Error('Invalid credentials');
      }
      throw new Error(e.message);
    } finally {
      client.end();
    }

    // Everything checks out.
    return true;
  }

}

module.exports = HeatPumpDriver;
