# Evidence

Raw outputs from load tests and scaling runs, kept for the report (scaling, caching and latency figures).

## Load test: 160 jobs, before and after the live backlog metric (2026-10-27, clean re-run 2026-10-31)

Same test each time: `services/bin/load-test.js --jobs=160`. That's 160 jobs submitted through the public API 16 at a time, each running a baseline shard and a mutant shard (7 executed mutants) on Fargate. All runs started from 0 tasks. **Run 3 is the valid comparison with run 1**: both used content no earlier run had seen.

| | Run 1: alarms on AWS/SQS metrics | Run 2: live metric, *reused content* | **Run 3: live metric, fresh content** |
|---|---|---|---|
| Files | `load-160.csv`, `scaling-load-160.txt` | `load-160-live-metric.csv`, `scaling-load-160-live-metric.txt` | `load-160-live-metric-fresh.csv`, `scaling-load-160-live-metric-fresh.txt` |
| Correct reports | 160/160 | 160/160 | 160/160 |
| Dead-lettered shards | 0 | 0 | 0 |
| First result | 289 s after first submit | 130 s † | **216 s** |
| Latency p50 / p95 / max | 329 / 360 / 361 s | 149 / 159 / 160 s † | **256 / 286 / 296 s** |
| Makespan (first submit → last result) | 363 s | 162 s † | **299 s** |
| Throughput once results flowed | 130 jobs/min | 301 jobs/min † | **114 jobs/min** |
| Peak workers | 12 (band ≥150) | 12 | 12 |
| Scale-in with work waiting | **Yes**: scale-to-zero stopped the only worker with 159 shards waiting (00:52:59) | No | No |
| Idle workers after the queue drained | 12 for ~1.5 min, then 6 for ~10 min (stale metrics kept the scale-out alarm in ALARM) | Back to 0 after 5 empty minutes | 12 → 1 at 01:57:58 UTC (about a minute after draining), 1 → 0 at 02:02:29 UTC (scaling history) |

† Not comparable with run 1: run 2 reused run 1's content, so most of its mutants came from the cache (see the correction below). Run 3 replaces it.

**Run 3's timeline** (`scaling-load-160-live-metric-fresh.txt`, local time): jobs submitted 11:51:29–11:51:32 and queued by 11:51:45; the published backlog showed 160 at 11:53:01; the scale-out alarm set 12 tasks at 11:54:03; all 12 ran by 11:54:33; first result 11:55:04; queue empty at 11:56:50; last result 11:56:28 by the CSV's clock. Throughput once flowing is the same as run 1 within noise, as expected with 12 workers in both runs; the live metric's gains are the earlier scale-out (about 70 s) and the two failure modes it removed.

**Why run 1 was slow:** SQS publishes its CloudWatch metrics 3–4 minutes late. The scale-to-zero alarm was reading five minutes of zeros from *before* the jobs arrived. The scale-out alarm only saw the backlog about 3.5 minutes after submission. In between, the service sat at 0 workers for about 2.5 minutes with 160 shards waiting.

**Fix:** a `backlog-publisher` Lambda reads the queue depth live (`GetQueueAttributes`) every minute and publishes `Proofline/Backlog`, which both alarms use. Missing data does nothing, so a stopped publisher can't cause a scale-in.

> **⚠️ Correction (found 2026-10-30).** Both runs used the same 160 commit contents (the test salted them `load-0`…`load-159` every time). Run 2's mutants were therefore mostly answered **from the durable result cache** at planning time: its timeline shows at most one job in `RUNNING`, whereas run 1 had up to 129. So run 2's **makespan, throughput and p50 latency are not comparable** with run 1's; part of the improvement is caching, not scaling.
>
> **What the comparison does support**, because all 160 baseline shards ran in both:
> - **time to first result 289 s → 130 s**, which is mainly scale-out reacting to live rather than lagged metrics (*superseded: the clean re-run, run 3, gives 216 s; run 2's first result also benefited from cached content*);
> - **no scale-in with work waiting** (run 1 stopped its only worker with 159 shards queued);
> - **no idle workers after the drain** (run 1 kept 6–12 for ~11 minutes).
>
> The load test now salts every run with a unique id, so a run can never inherit an earlier run's cached results. The clean re-run (run 3, `load-160-live-metric-fresh.csv`, 2026-10-31) replaces run 2's figures in the table above.

**What's left of run 2's latency** (kept for the record; run 3 above is the valid figure): about 60 s for the next publish and the alarm evaluation, plus about 30 s for Fargate to start 12 tasks, before the first shard runs. The 12 workers then drained the 160 baseline shards (most mutant shards were skipped: see the correction above) in about 35 s. The remaining delay is the price of scaling from zero rather than keeping a warm worker (about US$43/month for one always-on 1 vCPU / 2 GB task, per the Pricing Calculator rates).

## Utilisation during run 3 (2026-10-31)

`node infra/utilisation.js --csv=evidence/load-160-live-metric-fresh.csv --out=evidence/utilisation-load-160.json` (read-only: CloudWatch metrics and the service's scaling history for the test's window, 01:50:29–01:57:29 UTC, divided by 160 jobs).

| Resource | Total | Per job |
|---|---|---|
| Runner tasks | peak 12; 52.5 task-minutes (12 × 4.0 min + 1 × 4.5 min) | 19.7 task-seconds |
| Runner CPU (of 1 vCPU) | 30.3% average, 97.7% peak | |
| Runner memory (of 2 GB) | 3.8% average, 8.4% peak | |
| Lambda api | 4,329 invocations, 17 ms average, 505 ms max | 27.1 |
| Lambda planner / aggregator | 160 each; 158 ms / 513 ms average | 1 each |
| Lambda backlog publisher | 7 invocations, 187 ms average | |
| DynamoDB | 6,169 read units, 3,680 write units | 38.6 read, 23 write |
| API Gateway | 4,329 requests | 27.1 |
| SQS messages sent | 320 | 2 (baseline + mutant shard) |
| S3 bucket size | 1.9 MB | |

Scaling history (desired count): 0 → 12 at 01:53:58, 12 → 1 at 01:57:58, 1 → 0 at 02:02:29 UTC. Of the 52.5 task-minutes, about 27 were spent working (12 tasks from about 01:54:33 until the queue emptied at about 01:56:50); the rest was start-up and the idle tail. Lambda memory use could not be read: the account denies CloudWatch Logs Insights `StartQuery`.

## Cache test: 30 identical jobs on fresh content (2026-10-30)

`load-test.js --jobs=30 --identical`: 30 jobs verifying the **same** commit, whose content had never been seen before (unique run id), submitted at once. Totals from `services/bin/cache-report.js` (file: `load-30-identical-fresh.csv`).

| Source of each mutant result | Count | Share |
|---|---|---|
| **executed** (actually run) | **7** | 3.3% |
| coalesced (waited on another runner's in-progress run: single-flight lock) | 11 | 5.2% |
| hot (Valkey) | 171 | 81.4% |
| durable (DynamoDB, at run time) | 0 | 0% |
| planner (DynamoDB, at planning: no shard queued) | 21 | 10.0% |
| **total** | **210** | |

- **Each of the 7 executable mutants ran exactly once** across 30 jobs: 7 executions instead of 210 (30×). All 30 reports were correct (HIGH / 0.375).
- **Single-flight worked under real concurrency:** 11 times a runner found another runner already executing the same mutant and waited for its result instead of running it.
- **Layering:** jobs that planned early queued shards and were served by Valkey (hot, coalesced); jobs that planned after results reached DynamoDB were answered by the planner without queueing anything.
- The `durable` tier served nothing at run time because Valkey answered first (write-through to both tiers).
- Latency: p50 168 s, nearly all scale-from-zero. 27 jobs needed a shard; all finished within ~3 s of each other.

Runs before this one reused content and were answered entirely from the durable cache (`load-30-identical.csv`: 210/210 planner hits). That's correct behaviour, but it's why this test uses fresh content.
