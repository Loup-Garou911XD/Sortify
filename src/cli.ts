#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { applyRun, type Privacy } from "./apply.ts";
import { type Config, loadConfig, VERSION } from "./config.ts";
import { DIMENSIONS, type Dimension, Store } from "./db.ts";
import { enrichPlaylist } from "./enrich/pipeline.ts";
import { percent, table } from "./format.ts";
import { estimateQuota, planGroups } from "./planner.ts";
import { startServer } from "./server/index.ts";
import { createEnrichers, fetchPlaylist, youtubeFor } from "./services.ts";
import { authorize } from "./youtube/auth.ts";
import { parsePlaylistId } from "./youtube/playlistUrl.ts";

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("Expected a positive integer.");
  return n;
}

function openStore(config: Config): Store {
  return new Store(config.dbPath);
}

function requireFetched(store: Store, input: string): { playlistId: string; title: string } {
  const playlistId = parsePlaylistId(input);
  const playlist = store.getPlaylist(playlistId);
  if (!playlist)
    throw new Error(`Playlist ${playlistId} has not been fetched. Run \`sortify fetch\` first.`);
  return playlist;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

const program = new Command()
  .name("sortify")
  .description(
    "Split large YouTube / YouTube Music playlists into sub-playlists by subgenre, mood or song type.",
  )
  .version(VERSION);

program
  .command("auth")
  .description("Sign in to YouTube (opens a Google consent page)")
  .action(async () => {
    await authorize(loadConfig(), out);
  });

program
  .command("fetch")
  .description("Download a playlist's tracks into the local cache")
  .argument("<playlist>", "playlist URL (youtube.com or music.youtube.com) or ID")
  .action(async (input: string) => {
    const config = loadConfig();
    const playlistId = parsePlaylistId(input);
    const yt = youtubeFor(config);
    const store = openStore(config);
    try {
      const r = await fetchPlaylist(store, yt, playlistId);
      out(
        `Fetched "${r.title}": ${r.tracks} tracks (${r.newTracks} new). Quota used: ${r.quotaUsed} units.`,
      );
      out(`Next: sortify enrich ${playlistId}`);
    } finally {
      store.close();
    }
  });

program
  .command("enrich")
  .description("Tag tracks with subgenre, mood and song type from MusicBrainz, Discogs and Last.fm")
  .argument("<playlist>", "playlist URL or ID (must be fetched first)")
  .option("--force", "re-process tracks that were already enriched (cached lookups are reused)")
  .option("--max-api-calls <n>", "stop after this many uncached API calls", positiveInt)
  .option("--no-musicbrainz", "skip MusicBrainz matching")
  .action(
    async (
      input: string,
      opts: { force?: boolean; maxApiCalls?: number; musicbrainz: boolean },
    ) => {
      const config = loadConfig();
      const store = openStore(config);
      try {
        const { playlistId, title } = requireFetched(store, input);
        const { enrichers, budget } = createEnrichers(config, store, {
          maxApiCalls: opts.maxApiCalls,
          musicbrainz: opts.musicbrainz,
        });
        if (!enrichers.discogs)
          out("DISCOGS_TOKEN not set: skipping Discogs (main subgenre source).");
        if (!enrichers.lastfm)
          out("LASTFM_API_KEY not set: skipping Last.fm (the only mood source).");

        out(`Enriching "${title}"...`);
        const summary = await enrichPlaylist(store, playlistId, enrichers, {
          force: opts.force,
          onProgress: (done, total) => {
            if (done % 10 === 0 || done === total) out(`  ${done}/${total}`);
          },
        });
        out(`Enriched ${summary.enriched} tracks using ${budget.used} API calls.`);
        if (summary.stoppedByBudget) {
          out(
            `Stopped at --max-api-calls; ${summary.remaining} tracks left. Run the same command again to continue.`,
          );
        }
        out(`Next: sortify plan ${playlistId} --by subgenre`);
      } finally {
        store.close();
      }
    },
  );

program
  .command("plan")
  .description(
    "Group tracks and preview the playlists that would be created (writes nothing to YouTube)",
  )
  .argument("<playlist>", "playlist URL or ID")
  .addOption(
    new Option("--by <dimension>", "what to group by").choices([...DIMENSIONS]).default("subgenre"),
  )
  .option("--min-size <n>", "drop groups with fewer tracks than this", positiveInt, 5)
  .option("--max-groups <n>", "put each track in at most this many groups", positiveInt)
  .option("--no-leftovers", "do not create Other / Unsorted playlists")
  .action(
    (
      input: string,
      opts: { by: Dimension; minSize: number; maxGroups?: number; leftovers: boolean },
    ) => {
      const config = loadConfig();
      const store = openStore(config);
      try {
        const { playlistId, title } = requireFetched(store, input);
        const tracks = store.playlistTracks(playlistId);
        const unenriched = tracks.filter((t) => t.enrichedAt === null).length;
        if (unenriched > 0)
          out(`Warning: ${unenriched} tracks are not enriched yet (sortify enrich).`);

        const plan = planGroups(tracks, store.playlistTags(playlistId, opts.by), {
          dimension: opts.by,
          minSize: opts.minSize,
          maxGroupsPerTrack: opts.maxGroups,
          includeLeftovers: opts.leftovers,
        });
        const runId = store.createRun(playlistId, opts.by, opts.minSize, plan.groups);

        out(
          `"${title}" by ${opts.by}: ${plan.total} tracks, ${percent(plan.tagged, plan.total)} tagged.\n`,
        );
        out(
          table(
            ["Playlist", "Tracks"],
            plan.groups.map((g) => [g.name, g.videoIds.length]),
          ),
        );
        if (plan.dropped.length > 0) {
          const list = plan.dropped.map((d) => `${d.name} (${d.size})`).join(", ");
          out(`\nBelow --min-size ${opts.minSize}, dropped: ${list}`);
        }
        const est = estimateQuota(plan.groups, config.dailyQuota);
        out(
          `\nApplying needs ${est.playlists} playlists + ${est.additions} additions = ${est.units} quota units` +
            ` (about ${est.days} day${est.days === 1 ? "" : "s"} at ${config.dailyQuota} units/day).`,
        );
        out(`Saved as run ${runId}. Next: sortify apply ${runId}`);
      } finally {
        store.close();
      }
    },
  );

program
  .command("apply")
  .description("Create the planned playlists on YouTube; resumable after quota or limit stops")
  .argument("<run-id>", "run ID from `sortify plan`", positiveInt)
  .option("--dry-run", "show what would be written without calling YouTube")
  .option("-y, --yes", "do not ask for confirmation")
  .option("--max-writes <n>", "stop after this many write calls", positiveInt)
  .addOption(
    new Option("--privacy <status>", "privacy of new playlists")
      .choices(["private", "unlisted", "public"])
      .default("private"),
  )
  .action(
    async (
      runId: number,
      opts: { dryRun?: boolean; yes?: boolean; maxWrites?: number; privacy: Privacy },
    ) => {
      const config = loadConfig();
      const store = openStore(config);
      try {
        const run = store.getRun(runId);
        if (!run) throw new Error(`No run with id ${runId}. See \`sortify status\`.`);
        if (run.status === "done") {
          out(`Run ${runId} is already done.`);
          return;
        }
        const groups = store.runGroups(runId).map((g) => {
          const items = store.groupItems(g.groupId);
          return { ...g, total: items.length, pending: items.filter((i) => !i.written).length };
        });
        const toCreate = groups.filter((g) => g.targetPlaylistId === null).length;
        const toAdd = groups.reduce((sum, g) => sum + g.pending, 0);
        out(
          `Run ${runId} (${run.dimension}): ${toCreate} playlists to create, ${toAdd} tracks to add.`,
        );
        out(
          table(
            ["Playlist", "Tracks", "Left"],
            groups.map((g) => [g.name, g.total, g.pending]),
          ),
        );
        if (opts.dryRun) return;
        if (!opts.yes && !(await confirm(`Create these as ${opts.privacy} playlists?`))) {
          out("Cancelled.");
          return;
        }

        const result = await applyRun(store, youtubeFor(config), runId, {
          privacy: opts.privacy,
          maxWrites: opts.maxWrites,
          log: (line) => out(`  ${line}`),
        });
        out(
          `Created ${result.playlistsCreated} playlists, added ${result.tracksAdded} tracks` +
            `${result.tracksSkipped ? `, skipped ${result.tracksSkipped} unavailable` : ""}.` +
            ` Quota used: ${result.quotaUsed} units.`,
        );
        if (result.reason === "quota") {
          out(
            `Daily YouTube quota reached. Run \`sortify apply ${runId}\` again after it resets (midnight Pacific).`,
          );
        } else if (result.reason === "limit") {
          out(`Stopped at --max-writes. Run \`sortify apply ${runId}\` again to continue.`);
        } else {
          out("Done.");
        }
      } finally {
        store.close();
      }
    },
  );

program
  .command("status")
  .description("List runs, or show one run's progress")
  .argument("[run-id]", "run ID", positiveInt)
  .action((runId: number | undefined) => {
    const config = loadConfig();
    const store = openStore(config);
    try {
      if (runId === undefined) {
        const runs = store.listRuns();
        if (runs.length === 0) {
          out("No runs yet. Start with `sortify fetch <playlist>`.");
          return;
        }
        out(
          table(
            ["Run", "Playlist", "By", "Status", "Writes", "Quota", "Created"],
            runs.map((r) => [
              r.runId,
              store.getPlaylist(r.sourcePlaylistId)?.title ?? r.sourcePlaylistId,
              r.dimension,
              r.status,
              r.writesDone,
              r.quotaUsed,
              r.createdAt.slice(0, 16).replace("T", " "),
            ]),
          ),
        );
        return;
      }
      const run = store.getRun(runId);
      if (!run) throw new Error(`No run with id ${runId}`);
      out(
        `Run ${runId}: ${run.status}, ${run.writesDone} writes, ${run.quotaUsed} quota units used.`,
      );
      out(
        table(
          ["Playlist", "Tracks", "Written", "YouTube ID"],
          store.runGroups(runId).map((g) => {
            const items = store.groupItems(g.groupId);
            return [
              g.name,
              items.length,
              items.filter((i) => i.written).length,
              g.targetPlaylistId ?? "-",
            ];
          }),
        ),
      );
    } finally {
      store.close();
    }
  });

program
  .command("ui")
  .description("Open the web interface on this machine")
  .option("-p, --port <port>", "port to listen on", positiveInt, 4747)
  .action(async (opts: { port: number }) => {
    const { url, close } = await startServer(loadConfig(), { port: opts.port });
    out(`Sortify is running at ${url}`);
    out("Press Ctrl+C to stop.");
    const stop = (): void => {
      void close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`sortify: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
