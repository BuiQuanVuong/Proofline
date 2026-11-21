// Generates the report's diagrams as draw.io files: Figure 4 (vendor-agnostic),
// Figures 5a/5b (AWS) and Figures 6a/6b (job sequence). Each is sized so its
// text prints at roughly 10-12 pt when placed at the width of a landscape A4 page.
//   node report/figures/generate.mjs
// Open the .drawio files in draw.io (app.diagrams.net) to adjust them; the
// committed PNGs were exported at 2× scale.
//
// Every edge has fixed exit/entry points and waypoints, so lines never cross a
// node or another edge's label. Coordinates are absolute; icons are 60 × 60. `pos` moves an edge label
// along its edge (-1 = source end, 1 = target end).

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=13;endArrow=block;endFill=1;strokeWidth=1.5;labelBackgroundColor=#ffffff;";

function diagram(name, { groups, nodes, edges, width, height, edgeBase = EDGE }) {
  const cells = [];
  for (const n of [...groups, ...nodes]) {
    cells.push(`<mxCell id="${n.id}" value="${esc(n.label)}" style="${esc(n.style)}" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`);
  }
  edges.forEach((e, i) => {
    let style = edgeBase + (e.style ?? "");
    if (e.exit) style += `exitX=${e.exit[0]};exitY=${e.exit[1]};exitDx=0;exitDy=0;exitPerimeter=0;`;
    if (e.entry) style += `entryX=${e.entry[0]};entryY=${e.entry[1]};entryDx=0;entryDy=0;entryPerimeter=0;`;
    const pts = e.pts?.length ? `<Array as="points">${e.pts.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join("")}</Array>` : "";
    const off = e.offset ? `<mxPoint x="${e.offset[0]}" y="${e.offset[1]}" as="offset"/>` : "";
    cells.push(`<mxCell id="e${i}" value="${esc(e.label ?? "")}" style="${esc(style)}" edge="1" parent="1" source="${e.from}" target="${e.to}"><mxGeometry${e.pos ? ` x="${e.pos}"` : ""} relative="1" as="geometry">${pts}${off}</mxGeometry></mxCell>`);
  });
  const xml = `<mxfile host="proofline-generator"><diagram name="${esc(name)}"><mxGraphModel dx="${width}" dy="${height}" grid="1" gridSize="10" guides="1" page="1" pageWidth="${width}" pageHeight="${height}" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(path.join(here, `${name}.drawio`), xml);
  console.log(`wrote ${name}.drawio (${nodes.length} nodes, ${edges.length} edges)`);
}

// Label placement for icons (default: below).
const RIGHT = "verticalLabelPosition=middle;verticalAlign=middle;labelPosition=right;align=left;spacingLeft=4;";
const LEFT = "verticalLabelPosition=middle;verticalAlign=middle;labelPosition=left;align=right;spacingRight=4;";
const ABOVE = "verticalLabelPosition=top;verticalAlign=bottom;";
const TOPLEFT = "verticalLabelPosition=top;verticalAlign=bottom;labelPosition=left;align=right;spacingRight=-6;";

// ------------------------------------------------------- vendor-agnostic
// Figure 4: high level, one box per concern, text large enough to print at
// about 11-12 pt when the figure fills a landscape A4 page (~700 pt wide).
const BIG_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=21;endArrow=block;endFill=1;strokeWidth=2;labelBackgroundColor=#ffffff;";
const box = (fill, stroke) => `rounded=1;whiteSpace=wrap;html=1;fontSize=24;fillColor=${fill};strokeColor=${stroke};`;
const area = (fill, stroke) => `rounded=1;arcSize=4;whiteSpace=wrap;html=1;fontSize=22;fontStyle=1;verticalAlign=top;align=left;spacingLeft=10;dashed=1;fillColor=${fill};strokeColor=${stroke};`;
const COMPUTE = box("#ffe6cc", "#d79b00");
const STORE = box("#d5e8d4", "#82b366");
const MSG = box("#f8cecc", "#b85450");
const SEC = box("#e1d5e7", "#9673a6");
const OPS = box("#dae8fc", "#6c8ebf");
const n = (id, label, style, x, y, w = 180, h = 60) => ({ id, label, style, x, y, w, h });
// Relative exit/entry point of an absolute coordinate on a node's edge.
const rel = (node, x, y) => [+((x - node.x) / node.w).toFixed(3), +((y - node.y) / node.h).toFixed(3)];

{
  const N = {
    cli: n("cli", "Client (CLI)", box("#ffffff", "#000000"), 20, 300, 150, 90),
    idp: n("idp", "Identity provider", SEC, 270, 40, 200, 90),
    gw: n("gw", "API gateway<br>+ token check", SEC, 270, 300, 200, 90),
    fns: n("fns", "Control-plane functions<br>API · planner<br>aggregator<br>dead-letter handler", COMPUTE, 550, 270, 270, 170),
    asc: n("asc", "Autoscaler<br>(backlog metric)", OPS, 900, 40, 190, 90),
    q: n("q", "Work queue<br>+ dead-letter queue", MSG, 900, 300, 190, 90),
    bus: n("bus", "Event bus<br>(pub/sub)", MSG, 900, 560, 190, 90),
    reg: n("reg", "Image registry<br>+ secret store", OPS, 1170, 40, 210, 90),
    run: n("run", "Workers 0–N", COMPUTE, 1170, 300, 210, 90),
    mem: n("mem", "In-memory store", STORE, 1170, 560, 210, 90),
    obj: n("obj", "Object store", STORE, 280, 590, 220, 90),
    kv: n("kv", "Key-value store", STORE, 550, 590, 240, 90),
  };
  const G = {
    net: { id: "net", label: "Private network", x: 1150, y: 250, w: 250, h: 430, style: area("#f5f5f5", "#666666") + "verticalAlign=bottom;spacingBottom=4;" },
    sto: { id: "sto", label: "Storage", x: 250, y: 540, w: 570, h: 160, style: area("#f3fbf1", "#82b366") },
  };
  diagram("architecture-agnostic", {
    width: 1440, height: 760, edgeBase: BIG_EDGE,
    groups: Object.values(G), nodes: Object.values(N),
    edges: [
      { from: "cli", to: "idp", label: "1 sign in", exit: rel(N.cli, 95, 300), entry: [0, 0.5], pts: [[95, 85]] },
      { from: "cli", to: "gw", label: "2 calls", exit: [1, 0.5], entry: [0, 0.5] },
      { from: "cli", to: "obj", label: "3 upload", style: "dashed=1;", exit: [0.5, 1], entry: [0, 0.5], pts: [[95, 635]] },
      { from: "gw", to: "fns", exit: [1, 0.5], entry: rel(N.fns, 550, 345) },
      { from: "fns", to: "q", label: "shards", exit: rel(N.fns, 820, 345), entry: [0, 0.5] },
      { from: "q", to: "run", label: "pull", exit: [1, 0.5], entry: [0, 0.5] },
      { from: "q", to: "asc", label: "backlog", exit: rel(N.q, 950, 300), entry: rel(N.asc, 950, 130) },
      { from: "asc", to: "run", label: "desired count", exit: rel(N.asc, 1030, 130), entry: rel(N.run, 1210, 300), pts: [[1030, 205], [1210, 205]], pos: 0.25 },
      { from: "reg", to: "run", label: "image, token", style: "dashed=1;", exit: rel(N.reg, 1330, 130), entry: rel(N.run, 1330, 300), pos: -0.35 },
      { from: "run", to: "mem", label: "hot results<br>+ locks", exit: rel(N.run, 1340, 390), entry: rel(N.mem, 1340, 560) },
      { from: "run", to: "bus", label: "events", exit: rel(N.run, 1210, 390), entry: rel(N.bus, 995, 560), pts: [[1210, 510], [995, 510]] },
      { from: "bus", to: "fns", label: "triggers", exit: [0, 0.5], entry: rel(N.fns, 790, 440), pts: [[860, 605], [860, 485], [790, 485]], pos: -0.2 },
      { from: "fns", to: "kv", label: "jobs, reports", exit: rel(N.fns, 650, 440), entry: rel(N.kv, 650, 590), pos: -0.25 },
      { from: "run", to: "sto", label: "results, logs, coverage", exit: [1, 0.5], entry: [0.5, 1], pts: [[1425, 345], [1425, 735], [535, 735]], pos: 0.5 },
    ],
  });
}

// --------------------------------------------------------------- AWS
// Figure 5 is split in two so the text stays near 12 pt on a landscape page:
// 5a the request path and control plane, 5b the workers, scaling and cache.
// Icons are 70 × 70; labels sit wherever no edge leaves the icon.
const awsBig = (ic, fill, extra = "") => `sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=${fill};strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=21;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${ic};${extra}`;
const C = "#ED7100"; const D = "#C925D1"; const S = "#7AA116"; const I = "#E7157B"; const SECC = "#DD344C"; const M = "#E7157B";
const ic = (id, label, icn, fill, x, y, extra) => ({ id, label, x, y, w: 70, h: 70, style: awsBig(icn, fill, extra) });
const L_RIGHT = "verticalLabelPosition=middle;verticalAlign=middle;labelPosition=right;align=left;spacingLeft=6;";
const L_LEFT = "verticalLabelPosition=middle;verticalAlign=middle;labelPosition=left;align=right;spacingRight=6;";
const L_ABOVE = "verticalLabelPosition=top;verticalAlign=bottom;";
const USER = "sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#232F3E;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=21;aspect=fixed;shape=mxgraph.aws4.user;";
const STUB = "rounded=1;whiteSpace=wrap;html=1;fontSize=21;dashed=1;fillColor=#ffffff;strokeColor=#666666;fontColor=#333333;";
const awsArea = (grIcon, stroke) => `points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=21;fontStyle=1;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.${grIcon};strokeColor=${stroke};fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=${stroke};dashed=0;`;

{
  // 5a: request path and control plane
  const N = {
    user: { id: "user", label: "proofline CLI", x: 60, y: 340, w: 70, h: 70, style: USER },
    cog: ic("cog", "Cognito<br>user pool", "cognito", SECC, 320, 70),
    apigw: ic("apigw", "API Gateway<br>HTTP API + JWT", "api_gateway", I, 320, 340),
    s3: ic("s3", "S3 artifacts", "s3", S, 580, 70),
    lapi: ic("lapi", "λ api", "lambda", C, 580, 340, L_ABOVE),
    ddb: ic("ddb", "DynamoDB<br>single table", "dynamodb", D, 580, 610),
    agg: ic("agg", "λ aggregator", "lambda", C, 840, 70),
    sqs: ic("sqs", "SQS work queue", "sqs", I, 840, 340, L_ABOVE),
    plan: ic("plan", "λ planner", "lambda", C, 840, 610),
    runs: { id: "runs", label: "ECS runners<br>(Figure 5b)", x: 1060, y: 325, w: 200, h: 100, style: STUB },
    eb: ic("eb", "EventBridge<br>bus + rules", "eventbridge", I, 1125, 610),
  };
  diagram("architecture-aws-control", {
    width: 1330, height: 770, edgeBase: BIG_EDGE,
    groups: [], nodes: Object.values(N),
    edges: [
      { from: "user", to: "cog", label: "1 sign in", exit: [0.714, 0], entry: [0, 0.5], pts: [[110, 105]], pos: 0.65 },
      { from: "user", to: "apigw", label: "2 HTTPS + JWT", exit: [1, 0.5], entry: [0, 0.5] },
      { from: "user", to: "s3", label: "3 presigned PUT", style: "dashed=1;", exit: [0.214, 0], entry: [0.5, 0], pts: [[75, 25], [615, 25]] },
      { from: "apigw", to: "lapi", exit: [1, 0.5], entry: [0, 0.5] },
      { from: "lapi", to: "ddb", label: "jobs", exit: [0.5, 1], entry: [0.5, 0] },
      { from: "lapi", to: "sqs", label: "baseline shard", exit: [1, 0.5], entry: [0, 0.5] },
      { from: "sqs", to: "runs", label: "long poll", exit: [1, 0.5], entry: [0, 0.5] },
      { from: "runs", to: "eb", label: "events", exit: [0.5, 1], entry: [0.5, 0] },
      { from: "eb", to: "plan", label: "baseline passed", exit: [0, 0.5], entry: [1, 0.5] },
      { from: "plan", to: "sqs", label: "mutant shards", exit: [0.5, 0], entry: [0.5, 1] },
      { from: "plan", to: "ddb", label: "CACHE# lookups", exit: [0, 0.5], entry: [1, 0.5] },
      { from: "eb", to: "agg", label: "job completed", exit: [1, 0.5], entry: [1, 0.5], pts: [[1300, 645], [1300, 105]], pos: 0.55 },
      { from: "agg", to: "s3", label: "report", exit: [0, 0.5], entry: [1, 0.5] },
    ],
  });
}

{
  // 5b: workers, scaling and cache
  const N = {
    sqs: ic("sqs", "SQS work queue", "sqs", I, 60, 300, L_ABOVE),
    dlq: ic("dlq", "SQS dead-<br>letter queue", "sqs", I, 60, 500, L_RIGHT),
    dlqh: ic("dlqh", "λ dlq-handler", "lambda", C, 60, 690, L_RIGHT),
    ecr: ic("ecr", "ECR images", "ecr", C, 450, 40, L_LEFT),
    sm: ic("sm", "Secrets Manager", "secrets_manager", SECC, 700, 40, L_RIGHT),
    fg: ic("fg", "", "fargate", C, 575, 245),
    vk: ic("vk", "ElastiCache for Valkey<br>t4g.micro · TLS · :3001", "elasticache", D, 575, 540),
    sched: ic("sched", "EventBridge rule<br>rate(1 minute)", "eventbridge", I, 1180, 40, L_LEFT),
    pub: ic("pub", "λ backlog-<br>publisher", "lambda", C, 1180, 250, L_LEFT),
    cw: ic("cw", "CloudWatch<br>Proofline/Backlog + alarms", "cloudwatch_2", M, 1180, 460),
    asg: ic("asg", "Application<br>Auto Scaling", "application_auto_scaling", M, 960, 460),
    out: { id: "out", label: "Results to DynamoDB and S3;<br>events to EventBridge<br>(Figure 5a)", x: 950, y: 650, w: 330, h: 110, style: STUB },
  };
  const G = {
    vpc: { id: "vpc", label: "VPC · private subnets", x: 380, y: 170, w: 470, h: 600, style: awsArea("group_vpc2", "#8C4FFF") + "verticalAlign=bottom;spacingBottom=6;" },
    ecs: { id: "ecs", label: "ECS Fargate service<br>runners 0–20, scale-in protection", x: 410, y: 230, w: 400, h: 160, style: "rounded=1;arcSize=6;html=1;whiteSpace=wrap;fontSize=21;fontColor=#232F3E;fillColor=#fff4e8;strokeColor=#ED7100;verticalAlign=bottom;spacingBottom=6;" },
  };
  diagram("architecture-aws-workers", {
    width: 1320, height: 800, edgeBase: BIG_EDGE,
    groups: Object.values(G), nodes: Object.values(N),
    edges: [
      { from: "sqs", to: "ecs", label: "long poll", exit: [1, 0.5], entry: rel(G.ecs, 410, 335) },
      { from: "sqs", to: "dlq", label: "after 3<br>receives", style: "dashed=1;", exit: [0.5, 1], entry: [0.5, 0] },
      { from: "dlq", to: "dlqh", label: "event source", exit: [0.5, 1], entry: [0.5, 0] },
      { from: "ecr", to: "ecs", label: "image", style: "dashed=1;", exit: [0.5, 1], entry: rel(G.ecs, 485, 230), pos: -0.55 },
      { from: "sm", to: "ecs", label: "token", style: "dashed=1;", exit: [0.5, 1], entry: rel(G.ecs, 735, 230), pos: -0.55 },
      { from: "ecs", to: "vk", label: "hot tier + locks", exit: rel(G.ecs, 610, 390), entry: [0.5, 0] },
      { from: "sched", to: "pub", exit: [0.5, 1], entry: [0.5, 0] },
      { from: "pub", to: "sqs", label: "reads queue depth", style: "dashed=1;", exit: [1, 0.5], entry: [0, 0.5], pts: [[1290, 285], [1290, 18], [30, 18], [30, 335]], pos: 0.1 },
      { from: "pub", to: "cw", label: "live backlog", exit: [0.5, 1], entry: [0.5, 0] },
      { from: "cw", to: "asg", label: "alarms", exit: [0, 0.5], entry: [1, 0.5] },
      { from: "asg", to: "ecs", label: "desired count", exit: [0.5, 0], entry: rel(G.ecs, 810, 260), pts: [[995, 260]], pos: 0.3 },
      { from: "ecs", to: "out", exit: rel(G.ecs, 810, 360), entry: [0, 0.5], pts: [[870, 360], [870, 705]], pos: 0.4 },
    ],
  });
}

// ------------------------------------------------------------ sequence
// Figure 6, split in two (6a submission, 6b processing) so the text stays near
// 12 pt on a landscape page. Rows are laid out top to bottom; messages are
// free-standing edges between lifeline x positions, labels just above the line.
function sequence(name, { lanes, rows, width, first = 1, row = 40 }) {
  const X0 = 20, ROW = row, SELF = 30, BAND = 22;
  const bands = [], cells = [], lines = [];
  let y = 110, num = first - 1, id = 0, loop = null;
  const vertex = (label, style, x, yy, w, h, to = cells) =>
    to.push(`<mxCell id="v${id++}" value="${esc(label)}" style="${esc(style)}" vertex="1" parent="1"><mxGeometry x="${x}" y="${yy}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
  const edge = (label, style, [x1, y1], [x2, y2], pts = []) =>
    lines.push(`<mxCell id="m${id++}" value="${esc(label)}" style="${esc(style)}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${x1}" y="${y1}" as="sourcePoint"/><mxPoint x="${x2}" y="${y2}" as="targetPoint"/>${pts.length ? `<Array as="points">${pts.map(([px, py]) => `<mxPoint x="${px}" y="${py}"/>`).join("")}</Array>` : ""}</mxGeometry></mxCell>`);
  const MSG_STYLE = "html=1;fontSize=20;strokeWidth=2;labelBackgroundColor=#ffffff;verticalAlign=bottom;spacingBottom=1;endArrow=block;endFill=1;";
  const label = (text) => `<b>${++num}</b>  ${text}`;

  for (const r of rows) {
    if (r[0] === "phase") {
      y += 14;
      vertex(r[1], "rounded=0;html=1;fontSize=21;fontStyle=1;align=left;spacingLeft=10;fillColor=#f5f5f5;strokeColor=none;", X0, y, width - 2 * X0, 30, bands);
      y += 30 + BAND - 22;
    } else if (r[0] === "loop") {
      loop = { label: r[1], x1: lanes[r[2]][1] - 60, x2: lanes[r[3]][1] + 70, y, left: r[4] };
      y += 30;
    } else if (r[0] === "self") {
      const x = lanes[r[1]][1];
      y += 12;
      edge("", MSG_STYLE, [x, y], [x, y + 18], [[x + 32, y], [x + 32, y + 18]]);
      const text = label(r[2]);
      vertex(text, "text;html=1;align=left;verticalAlign=middle;fontSize=20;labelBackgroundColor=#ffffff;", x + 40, y - 4, Math.round(r[2].length * 9.5) + 34, 26);
      y += SELF - 12 + 6;
    } else {
      const [kind, from, to, text] = r;
      y += ROW;
      edge(label(text), MSG_STYLE + (kind === "reply" ? "dashed=1;endArrow=open;endFill=0;" : ""), [lanes[from][1], y], [lanes[to][1], y]);
    }
    if (loop && r[0] !== "loop" && --loop.left === 0) {
      vertex("", "rounded=0;html=1;fillColor=none;strokeColor=#666666;", loop.x1, loop.y, loop.x2 - loop.x1, y - loop.y + 14);
      vertex(loop.label, "text;html=1;align=left;verticalAlign=top;fontSize=20;fontStyle=1;spacingLeft=6;", loop.x1, loop.y + 2, 520, 26);
      y += 14;
      loop = null;
    }
  }
  const bottom = y + 30;
  for (const [text, x, style] of Object.values(lanes)) {
    vertex(text, style.replace("fontSize=24", "fontSize=22"), x - 95, 20, 190, 64);
    edge("", "html=1;endArrow=none;dashed=1;strokeColor=#999999;", [x, 84], [x, bottom]);
  }
  // Draw order: phase bands, lifelines, boxes and labels, then messages on top.
  const lifelines = lines.splice(lines.length - Object.keys(lanes).length);
  const xml = `<mxfile host="proofline-generator"><diagram name="${esc(name)}"><mxGraphModel dx="${width}" dy="${bottom}" grid="1" gridSize="10" guides="1" page="1" pageWidth="${width}" pageHeight="${bottom + 20}" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${[...bands, ...lifelines, ...cells, ...lines].join("")}</root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(path.join(here, `${name}.drawio`), xml);
  console.log(`wrote ${name}.drawio (messages ${first}–${num})`);
}

// 6a: submission (synchronous) and polling.
sequence("sequence-submit", {
  width: 1340,
  lanes: {
    cli: ["proofline CLI", 120, box("#ffffff", "#000000")],
    api: ["API Gateway<br>+ λ api", 470, COMPUTE],
    ddb: ["DynamoDB", 760, STORE],
    s3: ["S3", 1000, STORE],
    sqs: ["SQS work queue", 1230, MSG],
  },
  rows: [
    ["phase", "Submit (synchronous, about 1 s)"],
    ["msg", "cli", "api", "POST /v1/jobs (repo, SHAs, changed lines)"],
    ["self", "api", "verify JWT; validate paths, SHAs, limits"],
    ["msg", "api", "ddb", "job: UPLOADING"],
    ["reply", "api", "cli", "201  jobId + upload URL (5 min)"],
    ["msg", "cli", "s3", "PUT snapshot (bypasses the API)"],
    ["msg", "cli", "api", "POST /v1/jobs/{id}/start"],
    ["msg", "api", "s3", "HEAD snapshot (exists, ≤ 50 MB)"],
    ["msg", "api", "ddb", "UPLOADING → BASELINE"],
    ["msg", "api", "sqs", "BASELINE shard"],
    ["reply", "api", "cli", "202 Accepted"],
    ["phase", "Poll (repeats until the job is done; processing in Figure 6b)"],
    ["msg", "cli", "api", "GET /v1/jobs/{id}"],
    ["reply", "api", "cli", "status, progress, then the report"],
  ],
});

// 6b: processing (asynchronous).
sequence("sequence-process", {
  width: 1460, first: 13, row: 37,
  lanes: {
    sqs: ["SQS work queue", 110, MSG],
    run: ["Runner<br>(Fargate)", 360, COMPUTE],
    store: ["DynamoDB<br>and S3", 620, STORE],
    eb: ["EventBridge", 870, MSG],
    plan: ["λ planner", 1090, COMPUTE],
    agg: ["λ aggregator", 1330, COMPUTE],
  },
  rows: [
    ["phase", "Baseline (runner: the only place repository code runs)"],
    ["msg", "sqs", "run", "BASELINE shard (long poll)"],
    ["msg", "run", "store", "get snapshot (S3)"],
    ["self", "run", "suite ×2, then each test file with coverage"],
    ["msg", "run", "store", "coverage map; BASELINE → PLANNING"],
    ["msg", "run", "eb", "BaselineCompleted {passed: true}"],
    ["phase", "Plan (reads code, never runs it)"],
    ["msg", "eb", "plan", "rule: passed = true"],
    ["self", "plan", "static checks, mutants, cache keys"],
    ["msg", "plan", "store", "CACHE# lookups; PLANNING → RUNNING"],
    ["msg", "plan", "sqs", "MUTANTS shards (≤ 10 mutants each)"],
    ["phase", "Execute"],
    ["loop", "loop  [each shard, in parallel across runners]", "sqs", "eb", 4],
    ["msg", "sqs", "run", "MUTANTS shard"],
    ["self", "run", "per mutant: Valkey → DynamoDB → lock → test"],
    ["msg", "run", "store", "results + CACHE#; ADD shardId"],
    ["msg", "run", "eb", "JobCompleted (last shard only)"],
    ["phase", "Aggregate"],
    ["msg", "eb", "agg", "rule: JobCompleted"],
    ["msg", "agg", "store", "claim job (one winner); read results"],
    ["msg", "agg", "store", "report (S3); DONE + PVF verdict"],
  ],
});
