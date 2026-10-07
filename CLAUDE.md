# IVT Anywhere — Homey App

Homey SDK3 app (`se.anywhere.ivt`) that integrates IVT heat pumps with the Homey platform via the Bosch XMPP protocol (the same protocol used by IVT Anywhere / EasyControl gateways).

## Architecture

```
app.js                          # Homey App entry point
drivers/heat-pump/
  driver.js                     # Handles pairing & credential validation
  device.js                     # Core device logic: polling, capability handlers
lib/
  bosch-xmpp/                   # XMPP client (git submodule, Bosch/IVT protocol)
  gateway-client.js             # Wraps bosch-xmpp: strict reply matching, PUT, iq replies, connect timeout
  capabilities.js               # Maps Homey capability names → API endpoints
  errorcodes.js                 # IVT error code → description lookup table
  tokens.js                     # Flow token definitions
.homeycompose/
  app.json                      # App-level manifest (source of truth)
  capabilities/                 # Custom capability definitions
  flow/triggers/                # Flow trigger card definitions
docs/
  rawscan.txt                   # Raw YAML dump of all API endpoints on the heat pump
```

`app.json` at root is **generated** — edit `.homeycompose/app.json` instead, then run `homey app compose` to regenerate.

## Communication Protocol

The IVT gateway (iCom NSC) speaks HTTP-over-XMPP. The `bosch-xmpp` submodule handles the XMPP transport; `lib/gateway-client.js` replaces its `get`/`put` because the library hands a late reply to the *next* request. GET replies are only accepted when their `id` equals the requested endpoint (including any `?interval=` query). Messages look like raw HTTP requests/responses tunnelled through XMPP stanzas.

- **GET** `client.get(endpoint)` → returns parsed JSON body
- **PUT** `client.put(endpoint, { value: ... })` → `{ status: 'ok' }` on 2xx; 403 means the endpoint is locked for remote writes (seen on `temperatureLevels/eco`)
- Each request gets 2 attempts with a 10 s timeout; requests are serialized
- The gateway silently clamps out-of-range writes to the endpoint's min/max, so validate before writing
- Only one XMPP session per serial works; a second session steals the replies. If the gateway stops answering entirely (login works, no replies), rebooting the heat pump fixes it
- All communication is authenticated via serial number + access key + password (SCRAM-SHA-1 SASL)
- The `isWriting` flag prevents read polls from colliding with in-flight writes

## Available API Endpoints

Full reference in [`docs/rawscan.txt`](docs/rawscan.txt). Key endpoints:

### Domestic Hot Water (`/dhwCircuits/dhw1/`)
| Endpoint | Type | Writable | Notes |
|---|---|---|---|
| `operationMode` | stringValue | yes | `low`, `high`, `eco` |
| `actualTemp` | floatValue | no | Current DHW temp (°C) |
| `currentSetpoint` | floatValue | no | Active setpoint (°C) |
| `charge` | stringValue | yes | `start` / `stop` — triggers boost |
| `chargeDuration` | floatValue | yes | 60–2880 min |
| `singleChargeSetpoint` | floatValue | yes | 50–70 °C |
| `temperatureLevels/low` | floatValue | yes | 40–52 °C |
| `temperatureLevels/high` | floatValue | yes | 40–52 °C |
| `temperatureLevels/eco` | floatValue | yes | 30–46 °C |
| `status` | stringValue | no | `ACTIVE` / `INACTIVE` |
| `holidayMode/activated` | stringValue | no | `""`, `hm1`–`hm5` |

### Heating Circuit (`/heatingCircuits/hc1/`)
| Endpoint | Type | Writable | Notes |
|---|---|---|---|
| `temperatureRoomSetpoint` | floatValue | yes | 5–30 °C (used for target temp) |
| `manualRoomSetpoint` | floatValue | yes | 5–30 °C |
| `temporaryRoomSetpoint` | floatValue | yes | 5–30 °C, `-1` = not active |
| `roomtemperature` | floatValue | no | Measured room temp |
| `actualSupplyTemperature` | floatValue | no | Supply temp (°C) |
| `operationMode` | stringValue | yes | `manual` |
| `currentRoomSetpoint` | floatValue | no | Active setpoint |
| `pumpModulation` | floatValue | no | % |
| `status` | stringValue | no | Circuit status |
| `cooling` | refEnum | — | Cooling sub-endpoints |
| `holidayMode` | refEnum | — | Holiday mode sub-endpoints |

### Heat Sources (`/heatSources/`)
| Endpoint | Notes |
|---|---|
| `actualSupplyTemperature` | Supply line temp |
| `returnTemperature` | Return line temp |
| `flameStatus` | Burner on/off |
| `actualModulation` | % modulation |
| `workingTime` | Hours |

### System (`/system/`)
| Endpoint | Notes |
|---|---|
| `sensors/temperatures/outdoor_t1` | Outdoor temp |
| `healthStatus` | `ok` or error string — maps to `alarm_status` |
| `notifications` | Array of active error objects with `ccd` error codes |

### Energy Recordings (`/recordings/heatSources/total/energyMonitoring/`)
Appended with date string `YYYY-MM-DD`. Returns hourly `recording` array.
- `consumedEnergy` → `meter_power.last_hour_total`
- `eheater` → `meter_power.last_hour_eheater`
- `compressor` → `meter_power.last_hour_compressor`
- `outputProduced` → heat produced; `cop` = today's produced ÷ consumed (completed hours)

Energy value per slot: `recording[hour].y / recording[hour].c` (skip slots with `c == 0`). Slots are indexed by **local** hour and the date is the local date; Homey apps run in UTC, so use `device.localTime()`. The last full hour is `now - 1h` (previous day's slot 23 just after midnight). Recordings are read once per hour, 5 minutes after the hour.

### Gateway (`/gateway/`)
- `versionFirmware` — used during pairing to validate credentials
- `DateTime` — writable

## Implemented Capabilities

| Homey Capability | Maps to | R/W |
|---|---|---|
| `measure_temperature` | `/heatingCircuits/hc1/roomtemperature` | R |
| `target_temperature` (10–30°C, step 0.5) | `/heatingCircuits/hc1/temperatureRoomSetpoint` | R/W |
| `measure_temperature.supply` | `/heatSources/actualSupplyTemperature` | R |
| `measure_temperature.return` | `/heatSources/returnTemperature` | R |
| `measure_temperature.outdoor` | `/system/sensors/temperatures/outdoor_t1` | R |
| `measure_temperature.water` | `/dhwCircuits/dhw1/actualTemp` | R |
| `ivt_hotwater_mode` (enum: eco/high/low) | `/dhwCircuits/dhw1/operationMode` | R/W |
| `hotwater_boost` (button) | `/dhwCircuits/dhw1/charge` | W |
| `alarm_status` (boolean) | `/system/healthStatus` + `/notifications` | R |
| `meter_power.last_hour_total` | energy recordings | R |
| `meter_power.last_hour_eheater` | energy recordings | R |
| `meter_power.last_hour_compressor` | energy recordings | R |
| `meter_power` (cumulative, Energy dashboard) | energy recordings | R |
| `cop` | `outputProduced` ÷ `consumedEnergy`, today | R |

## Custom Capabilities (in `.homeycompose/capabilities/`)

- `alarm_status` — boolean sensor, not setable
- `hotwater_boost` — boolean button, setable
- `ivt_hotwater_mode` — enum picker (eco/high/low), setable
- `cop` — number sensor (2 decimals), today's coefficient of performance

## Flow Cards

- **Trigger** `alarm_status_error` — fires with tokens `code` (error codes) and `description` (human-readable)
- **Trigger** `alarm_status_ok` — fires when all errors clear
- **Condition** `hotwater_mode_is` — compares the cached `ivt_hotwater_mode` value (eco/low/high)
- **Condition** `compressor_is_running` — reads the cached `compressor_active` value
- **Action** `set_hotwater_mode` — sets eco/low/high via the `ivt_hotwater_mode` capability listener
- **Action** `extra_hot_water` — starts a DHW charge via the `hotwater_boost` capability listener
- **Action** `set_hotwater_temperature` — writes `/dhwCircuits/dhw1/temperatureLevels/{low,high}` (40–52 °C). `eco` is listed as writable in rawscan but the gateway answers 403 to remote writes, so it is not offered.

Device action cards live in `drivers/heat-pump/driver.flow.compose.json` (Compose adds the `device` arg automatically — don't declare it) and their run listeners are registered in `driver.js` `onInit()`.

## Development

```bash
# Install dependencies
npm install

# Lint
npm run lint

# Deploy to Homey (requires homey CLI)
homey app run          # development run with live logs
homey app install      # install on Homey
homey app compose      # regenerate app.json from .homeycompose/
```

Settings (configured per device in Homey):
- `serial` — heat pump serial number
- `key` — access key (printed on unit)
- `password` — IVT Anywhere password
- `interval` — polling interval in seconds (10–3600, default 60)

## Homey MCP

The Homey MCP is available in this project for inspecting live device state, testing flows, and reading capability values without deploying code. Use it to verify that capability values are being set correctly.

## Conventions

- Errors from capability writes are propagated via `Promise.reject(err)`; reads silently continue on error (empty `catch` blocks in the polling loop are intentional — partial data is better than crashing)
- `updateValue()` only calls `setCapabilityValue` when the value has actually changed to avoid unnecessary Homey events
- `alarm_status` needs special handling: the raw API returns `"ok"` (no alarm) vs an error string, which must be converted to a boolean
- The `bosch-xmpp` directory is a git submodule — do not edit it directly
