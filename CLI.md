# Sortify command line

Every step of the web interface is also available as a command. Here `sortify` stands for `npm run -s sortify --` run from the repo root (or `node backend/dist/cli.js` after a build). See the [README](README.md) for setup.

```sh
sortify auth                                                    # sign in to YouTube
sortify fetch "https://music.youtube.com/playlist?list=PL..."   # read the playlist (cheap on quota)
sortify enrich PL...                                            # tag tracks; resumable, cached
sortify plan PL... --by subgenre --min-size 5                   # preview; writes nothing
sortify apply <run-id>                                          # create playlists (asks first)
sortify status [run-id]                                         # progress of runs
sortify links <run-id>                                          # youtube.com links to play each group (no quota)
sortify delete <run-id>                                         # delete a saved plan (YouTube playlists stay)
sortify ui                                                      # start the web interface
```

- `--by` is `subgenre`, `mood` or `type`. A track goes into **every** group it matches; `--max-groups N` caps that.
- Groups smaller than `--min-size` are dropped. Tracks left without a group go to *Other*, tracks with no tags at all to *Unsorted* (`--no-leftovers` skips both).
- `enrich --max-api-calls N` and `apply --max-writes N` limit a single run. Run the same command again to continue.
- `enrich --skip itunes,spotify` leaves out some tag sources for one run, and `enrich --force` tags already tagged tracks again (cached lookups are reused).
- `apply` creates **private** playlists by default (`--privacy unlisted|public`), and `--dry-run` shows what it would do.
- `links` needs no quota or sign-in: each link opens up to 50 tracks as a temporary playlist on youtube.com, which you can save there.

`sortify <command> --help` lists every option.
