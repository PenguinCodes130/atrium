# Home Assistant

Official package `home-assistant` (architecture v3 section 3.2, amendment A1.5).

Setup: the base URL (usually port 8123) and one long-lived access token, sent as a Bearer token. In Home Assistant, open your profile, then Security, then Create token.

## Reads

| Endpoint | Request | Shape |
|----------|---------|-------|
| `states` | `GET /api/states`; with `area`, also the documented read POST below | table: entity id, name, domain, state |
| `entity` | `GET /api/states/<entity id>` | status |
| `history` | `GET /api/history/period/<start>?filter_entity_id=...&minimal_response` | series |
| `areas` | the documented read POST below | table: id, name |

Health: `GET /api/config`, which reports the version.

### Documented read POST

`POST /api/template` renders a Jinja template and changes nothing. Home Assistant's REST API has no plain areas read, so `areas` and the `area` filter of `states` use it (amendment A1.5). The area id is checked against `^[a-z0-9_]+$` before it is put in the template, so no quote or brace can reach it.

## Commands

All take an entity id as their target (a literal fixed by the app's author, drawn from `states` filtered to the command's domain). Each sends one `POST /api/services/<domain>/<service>`.

| Command | Risk |
|---------|------|
| `light.turn_on` (optional `brightnessPct`, `colorTempK`, `rgb`) | low |
| `light.turn_off`, `light.toggle` | low |
| `switch.turn_on`, `switch.turn_off`, `switch.toggle` | low |
| `scene.turn_on` | low |
| `script.turn_on` | medium, owner only (a script can do anything) |

Deliberately not commands: locks, alarms and arbitrary service calls (n8n actions only); fans, covers, media and climate (a later package version).

## Detection

A URL is offered as Home Assistant when `/manifest.json` names "Home Assistant" and `GET /api/` answers 401 without a token.
