# Integrations

Code that talks to another module (Spell Book, Hero Mancer, Midi QoL, Chris's Premades) or to a specific host (The Forge) lives here, one file per module or host.

Each file is only loaded when that module is active or that host is detected. Nothing outside this folder may reference another module's internals. Character Hub works fully with this folder empty.
