'use strict';

const { Device } = require('homey');
const { createGatewayClient } = require('../../lib/gateway-client');
const Capabilities = require('../../lib/capabilities');
const ErrorCodes = require('../../lib/errorcodes');

const HOTWATER_LEVEL_LIMITS = {
  low: { min: 40, max: 52 },
  high: { min: 40, max: 52 },
};

const ENERGY_ENDPOINT = '/recordings/heatSources/total/energyMonitoring';
const LAST_HOUR_SOURCES = {
  'meter_power.last_hour_total': 'consumedEnergy',
  'meter_power.last_hour_eheater': 'eheater',
  'meter_power.last_hour_compressor': 'compressor',
};
// The gateway fills in an hour's recording slot shortly after the hour ends.
const ENERGY_SETTLE_MINUTES = 5;

// A recording slot holds the sum (y) and count (c) of samples for one hour.
const slotKwh = (slot) => (slot && slot.c > 0 ? slot.y / slot.c : null);
const sumKwh = (slots) => slots.reduce((sum, slot) => sum + (slotKwh(slot) ?? 0), 0);
const round2 = (value) => Math.round(value * 100) / 100;

class HeatPumpDevice extends Device {

  async onInit() {
    this.data = this.getData();
    this.client = null;
    this.pendingWrites = 0;
    this.polling = false;
    this.reconnecting = false;
    this.energyHourKey = null;

    // Add capabilities introduced after initial pairing
    for (const cap of ['compressor_active', 'pump_modulation', 'measure_temperature.water_setpoint', 'meter_power', 'cop']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('ivt_hotwater_mode', this.onCapabilityHotWaterMode.bind(this));
    this.registerCapabilityListener('hotwater_boost', this.onCapabilityHotWaterBoost.bind(this));

    await this.connect();

    // Initial Data Fetch (Delayed 2s to ensure SSL stability)
    this.homey.setTimeout(() => this.poll(), 2000);
    this.startPolling(this.getSetting('interval'));

    this.log('IVT heat pump device has been initialized');
  }

  get isWriting() {
    return this.pendingWrites > 0;
  }

  startPolling(intervalSeconds) {
    const updateInterval = Number(intervalSeconds) * 1000;
    this.log(`[${this.getName()}] Update Interval: ${updateInterval}ms`);
    this.homey.clearInterval(this.interval);
    this.interval = this.homey.setInterval(() => this.poll(), updateInterval);
  }

  async connect() {
    try {
      this.client = await this.getClient(this.getSettings());
      await this.setAvailable();
      return true;
    } catch (err) {
      this.client = null;
      this.error(`Unable to connect to heat pump: ${err.message}`);
      await this.setUnavailable(err.message).catch(this.error);
      return false;
    }
  }

  // A full poll can outlast the interval when the gateway is slow, so skip
  // ticks instead of letting requests pile up in the client's serial queue.
  async poll() {
    if (this.polling || this.isWriting || this.reconnecting) return;
    this.polling = true;
    try {
      if (!this.client && !(await this.connect())) return;
      await this.getDeviceData();
    } catch (err) {
      this.error('Poll failed:', err);
    } finally {
      this.polling = false;
    }
  }

  // Homey apps run in UTC, but the gateway records energy per local hour and date.
  localTime(date) {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: this.homey.clock.getTimezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).forEach(({ type, value }) => {
      parts[type] = value;
    });
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  }

  // --- CONTROL HANDLERS ---

  async write(endpoint, value) {
    if (!this.client) throw new Error('Not connected to the heat pump');
    this.pendingWrites++;
    try {
      await this.client.put(endpoint, { value });
    } catch (err) {
      const status = err.response?.statusCode;
      this.error(`Write to ${endpoint} failed:`, status ? `HTTP ${status} ${err.response.statusMessage}` : err.message);
      if (status === '403') throw new Error('The heat pump does not allow this setting to be changed remotely');
      throw err;
    } finally {
      this.pendingWrites--;
    }
  }

  async onCapabilityTargetTemperature(value) {
    await this.write('/heatingCircuits/hc1/temperatureRoomSetpoint', parseFloat(value));
  }

  async onCapabilityHotWaterMode(value) {
    await this.write('/dhwCircuits/dhw1/operationMode', value);
  }

  async onCapabilityHotWaterBoost(value) {
    if (!value) return;
    await this.write('/dhwCircuits/dhw1/charge', 'start');
    this.homey.setTimeout(() => {
      this.setCapabilityValue('hotwater_boost', false).catch(this.error);
    }, 2000);
  }

  async setHotWaterTemperature(level, temperature) {
    const limits = HOTWATER_LEVEL_LIMITS[level];
    if (!limits) throw new Error(`Unknown hot water mode: ${level}`);
    if (temperature < limits.min || temperature > limits.max) {
      throw new Error(`The ${level} hot water mode accepts ${limits.min}–${limits.max} °C`);
    }
    await this.write(`/dhwCircuits/dhw1/temperatureLevels/${level}`, temperature);
  }

  // --- DATA FETCHING ---

  async getDeviceData() {
    for (const { name, endpoint } of Object.values(Capabilities)) {
      if (this.isWriting) return;
      try {
        const res = await this.client.get(endpoint);
        let result = res.value;
        // Ensure Number type for temperatures to support Thermostat Dial
        if (typeof result === 'string' && result !== '' && !Number.isNaN(Number(result))) {
          result = parseFloat(result);
        }
        await this.updateValue(name, result);
      } catch (err) {
        this.log(`Failed to fetch ${name}:`, err.message);
      }
    }

    if (this.isWriting) return;
    try {
      const res = await this.client.get('/dhwCircuits/dhw1/operationMode');
      if (typeof res?.value === 'string') {
        await this.updateValue('ivt_hotwater_mode', res.value.toLowerCase());
      }
    } catch (err) {
      this.log('Failed to fetch ivt_hotwater_mode:', err.message);
    }

    if (this.isWriting) return;
    try {
      const res = await this.client.get('/heatingCircuits/hc1/temperatureRoomSetpoint');
      if (res?.value) {
        await this.updateValue('target_temperature', parseFloat(res.value));
      }
    } catch (err) {
      this.log('Failed to fetch target_temperature:', err.message);
    }

    if (this.isWriting) return;
    try {
      const res = await this.client.get('/heatSources/flameStatus');
      if (res?.value !== undefined) {
        await this.updateValue('compressor_active', res.value === 'on');
      }
    } catch (err) {
      this.log('Failed to fetch compressor_active:', err.message);
    }

    if (this.isWriting) return;
    await this.updateEnergyIfDue();
  }

  // Recordings only change once an hour, so read them once per hour.
  async updateEnergyIfDue() {
    const now = this.localTime(new Date());
    const hourKey = `${now.date} ${now.hour}`;
    if (hourKey === this.energyHourKey) return;
    if (this.energyHourKey && now.minute < ENERGY_SETTLE_MINUTES) return;
    if (await this.updateEnergy(now)) this.energyHourKey = hourKey;
  }

  async updateEnergy(now) {
    const recordings = new Map();
    const readRecording = async (source, date) => {
      const key = `${source}?interval=${date}`;
      if (!recordings.has(key)) {
        const res = await this.client.get(`${ENERGY_ENDPOINT}/${key}`);
        recordings.set(key, res?.recording || []);
      }
      return recordings.get(key);
    };

    const lastHour = this.localTime(new Date(Date.now() - 60 * 60 * 1000));
    for (const [capability, source] of Object.entries(LAST_HOUR_SOURCES)) {
      try {
        const kwh = slotKwh((await readRecording(source, lastHour.date))[lastHour.hour]);
        if (kwh !== null) await this.updateValue(capability, round2(kwh));
      } catch (err) {
        this.log(`Failed to fetch ${capability}:`, err.message);
      }
    }

    try {
      const consumedToday = sumKwh((await readRecording('consumedEnergy', now.date)).slice(0, now.hour));
      await this.updateCumulativeEnergy(now.date, consumedToday, readRecording);

      const producedToday = sumKwh((await readRecording('outputProduced', now.date)).slice(0, now.hour));
      if (consumedToday > 0) {
        await this.updateValue('cop', round2(producedToday / consumedToday));
      }
      return true;
    } catch (err) {
      this.log('Failed to update energy totals:', err.message);
      return false;
    }
  }

  // meter_power must only grow, so completed days are folded into a stored base.
  async updateCumulativeEnergy(today, consumedToday, readRecording) {
    const lastDate = this.getStoreValue('energy_last_date');
    if (lastDate && lastDate !== today) {
      const dayTotal = sumKwh(await readRecording('consumedEnergy', lastDate));
      const newBase = (this.getStoreValue('energy_base_kwh') || 0) + dayTotal;
      await this.setStoreValue('energy_base_kwh', newBase);
      this.log(`Energy rollover: added ${dayTotal.toFixed(3)} kWh for ${lastDate}, base now ${newBase.toFixed(3)} kWh`);
    }
    if (lastDate !== today) await this.setStoreValue('energy_last_date', today);

    const base = this.getStoreValue('energy_base_kwh') || 0;
    await this.updateValue('meter_power', round2(base + consumedToday));
  }

  async updateValue(capability, value) {
    if (capability === 'alarm_status') {
      const isAlarm = (String(value).toLowerCase() !== 'ok');
      if (this.getCapabilityValue(capability) !== isAlarm) {
        this.triggerAlarmStatusChange(isAlarm);
        await this.setCapabilityValue(capability, isAlarm).catch(this.error);
      }
      return;
    }

    if (this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value).catch(this.error);
    }
  }

  async triggerAlarmStatusChange(value) {
    if (value) {
      try {
        const res = await this.client.get('/notifications');
        const values = Array.isArray(res?.values) ? res.values : [];
        const tokens = {
          code: values.map((obj) => obj.ccd).join(', '),
          description: values
            .map((obj) => `${obj.ccd}: ${ErrorCodes[obj.ccd]?.description ?? 'Unknown error'}`)
            .join(', '),
        };
        await this.homey.flow.getDeviceTriggerCard('alarm_status_error').trigger(this, tokens);
      } catch (error) {
        this.error(error);
      }
    } else if (this.getCapabilityValue('alarm_status') === true) {
      this.homey.flow.getDeviceTriggerCard('alarm_status_ok').trigger(this).catch(this.error);
    }
  }

  async onAdded() {
    this.log('Device added');
  }

  async onSettings({ newSettings, changedKeys }) {
    if (['serial', 'key', 'password'].some((key) => changedKeys.includes(key))) {
      // The gateway allows one session per serial, so close the old one first.
      // On failure the settings are rejected and polling reconnects with the old ones.
      this.reconnecting = true;
      try {
        if (this.client) this.client.end();
        this.client = null;
        this.client = await this.getClient(newSettings);
        await this.setAvailable();
      } catch (err) {
        throw new Error(`Could not connect with the new settings: ${err.message}`);
      } finally {
        this.reconnecting = false;
      }
    }

    if (changedKeys.includes('interval')) {
      this.startPolling(newSettings.interval);
    }
  }

  // Also called by the driver during pairing, with `this` bound to the driver.
  async getClient(settings) {
    const client = await createGatewayClient(settings, {
      onError: (err) => this.error('XMPP Client Error:', err.message),
    });
    this.log('Device connected');
    return client;
  }

  async onDeleted() {
    this.homey.clearInterval(this.interval);
    if (this.client) this.client.end();
    this.client = null;
  }

}

module.exports = HeatPumpDevice;
