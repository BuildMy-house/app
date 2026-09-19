# Shared Engineering Rules

## Project name

This app is part of **buildmy.house**. "Homely" and "house_designer" were
this repo's internal dev codenames before the project settled on its
current name — they are not a separate product. They still appear
throughout this repo's existing code and infra (env vars like
`HOMELY_AUTOMATION_PORT`, the `homely/` directory, Docker volume names,
README headings) as long-standing functional identifiers; that's not being
renamed as a docs cleanup. Just don't introduce more "Homely"/"house_designer"
naming going forward, and call the project buildmy.house in new prose,
tickets, and communication.

- Read local instructions before changing code.
- Keep changes minimal and preserve unrelated work.
- Verify changes before reporting them complete.
- Never commit credentials; use environment variables.
