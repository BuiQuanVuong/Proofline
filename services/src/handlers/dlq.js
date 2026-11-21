// SQS event source on the dead-letter queue: a shard that failed 3 times.
// Without this, its job would wait forever. The message is kept in S3 for
// diagnosis, then the job is closed out:
//   BASELINE -> job BASELINE_FAILED
//   MUTANTS  -> shard recorded as failed; if it was the last, the job
//               completes as partial (the report counts the missing results)

import { EVENT, emit } from "../events.js";
import { STATUS } from "../keys.js";
import { failShard, putObject, updateJob } from "../store.js";
import { loadConfig } from "../config.js";

export const handler = async (event) => {
  const cfg = await loadConfig();
  for (const record of event.Records ?? []) {
    let msg;
    try {
      msg = JSON.parse(record.body);
    } catch {
      console.error(JSON.stringify({ msg: "unparseable DLQ message dropped", messageId: record.messageId }));
      continue;
    }
    const { jobId, shardId, type } = msg;
    await putObject(cfg, `logs/${jobId}/${shardId}.dlq.json`, JSON.stringify({
      receivedAt: new Date().toISOString(), receiveCount: record.attributes?.ApproximateReceiveCount, message: msg,
    }, null, 2));

    if (type === "BASELINE") {
      const changed = await updateJob(cfg, jobId, {
        status: STATUS.BASELINE_FAILED,
        failures: ["the runner failed the baseline 3 times; see the shard logs"],
      }, { expectStatus: STATUS.BASELINE });
      if (changed) await emit(cfg, "dlq", EVENT.BASELINE_COMPLETED, { jobId, passed: false });
      console.log(JSON.stringify({ msg: "baseline dead-lettered", jobId, closed: changed }));
      continue;
    }

    try {
      const { completed, failed, total, done } = await failShard(cfg, jobId, shardId);
      if (done) await emit(cfg, "dlq", EVENT.JOB_COMPLETED, { jobId, partial: true });
      console.log(JSON.stringify({ msg: "shard dead-lettered", jobId, shardId, completed, failed, total }));
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      console.error(JSON.stringify({ msg: "dead-lettered shard for unknown job", jobId, shardId }));
    }
  }
};
