# Character Hub

A Foundry VTT module for the dnd5e system. Players edit their characters in an always-online **hub world**, and their changes go back to the GM's **home worlds** for approval.

**Status:** early development. Not ready for use yet.

## How it works

- The GM marks characters as *in use* in a home world, and copies appear in the hub.
- Players edit their copies in the hub with normal Foundry sheets, then press **Submit changes**.
- The next time the GM opens the home world, they approve or reject each change.
- A small Cloudflare Worker passes data between the worlds, since Foundry worlds cannot talk to each other directly.

## Requirements

- Foundry VTT v13 or v14
- dnd5e system
- No other modules required
