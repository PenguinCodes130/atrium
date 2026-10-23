# Custom API

Connects any JSON API without code. Endpoints are stored as `CustomEndpoint` records, built from an OpenAPI document or by example ("Try it").

- Requests: GET, or POST only for an endpoint whose remote API needs POST to read (for example a GraphQL query). The method is shown on every endpoint.
- Secrets: a bearer token or API key found in a pasted curl command becomes a secret field on the integration. It is sealed in the vault and never shown again.
- Refresh: at least 10 seconds per endpoint.
- Spec import v2 (Wave 2.8): an OpenAPI 3.0/3.1 or Swagger 2 spec (found at the address, pasted as a URL, or uploaded; JSON, and YAML once `js-yaml` is installed) becomes ranked, grouped reads with settings. Only GET calls become reads; other calls are listed as changes the service could make, off until an owner adds one and sets its risk.
- Settings: `params` is a JSON Schema; `{{ params.x }}` in the path or a query value is filled after the settings are checked, URL-encoded. A query entry whose setting is empty is not sent. Detail calls get a dropdown from their list call (`x-atrium-choices`).
- Formats: `format` (one value or a series) and `columnFormats` (per table column key) say how numbers are shown; a `*Ticks` field shown as seconds is divided by 10,000,000.
