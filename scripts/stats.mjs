/**
 * Renders the profile statistics as an SVG committed to this repo.
 *
 * Every off-the-shelf stats widget is a single shared deployment calling the
 * GitHub API on behalf of every profile that embeds it, so they sit at their
 * rate limit and answer 200 with an SVG reading ERROR!!!. This does the same
 * work inside an Action, where the only quota being spent is this repo's.
 *
 *   node scripts/stats.mjs > stats.svg
 *
 * GITHUB_TOKEN is optional: without it the public API still answers, just with
 * a lower rate limit.
 *
 * Languages are averaged across repos rather than summed by byte. Summing bytes
 * sounds more precise and is badly wrong: one Unity WebGL export carries 51 MB
 * of generated JavaScript, which alone is 73% of everything ever pushed here and
 * buries the languages actually written by hand. Normalising each repo to its own
 * 100% first means a generated build counts once, like every other repo.
 */

const USER = process.env.STATS_USER ?? "trickster26";
const token = process.env.GITHUB_TOKEN;

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${USER}-profile-stats`,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new Error(
        `Rate limited on ${path}. Without a token the public API allows 60 requests an hour, ` +
          `which is not enough to read languages from every repo. Run this from Actions, ` +
          `where GITHUB_TOKEN raises the limit.`,
      );
    }
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Total commits across public repos, via GraphQL. Needs a token; skipped without one. */
async function totalCommits() {
  if (!token) return null;
  const year = new Date().getFullYear();
  const years = [year, year - 1, year - 2, year - 3, year - 4];
  const query = `query($login:String!){user(login:$login){${years
    .map(
      (y) =>
        `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${y}-12-31T23:59:59Z"){totalCommitContributions restrictedContributionsCount}`,
    )
    .join(" ")}}}`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  const user = body?.data?.user;
  if (!user) return null;
  return Object.values(user).reduce(
    (sum, y) => sum + y.totalCommitContributions + y.restrictedContributionsCount,
    0,
  );
}

const user = await api(`/users/${USER}`);

const repos = [];
for (let page = 1; ; page++) {
  const batch = await api(`/users/${USER}/repos?per_page=100&page=${page}&type=owner`);
  repos.push(...batch);
  if (batch.length < 100) break;
}

const own = repos.filter((r) => !r.fork);
const stars = own.reduce((n, r) => n + r.stargazers_count, 0);
const forks = own.reduce((n, r) => n + r.forks_count, 0);

// Each repo is normalised to its own 100%, then averaged across repos.
const shares = {};
let failed = 0;
let counted = 0;
for (const repo of own) {
  try {
    const langs = await api(`/repos/${repo.full_name}/languages`);
    const repoTotal = Object.values(langs).reduce((a, b) => a + b, 0);
    if (!repoTotal) continue;
    for (const [name, n] of Object.entries(langs)) {
      shares[name] = (shares[name] ?? 0) + n / repoTotal;
    }
    counted++;
  } catch (error) {
    if (String(error.message).startsWith("Rate limited")) throw error;
    failed++;
  }
}

// A chart built from a handful of repos would be confidently wrong, which is
// worse than no chart. Refuse to render one.
if (failed > own.length * 0.2) {
  throw new Error(`Languages unreadable for ${failed} of ${own.length} repos. Refusing to render a partial chart.`);
}

const commits = await totalCommits();

const total = counted || 1;
const ranked = Object.entries(shares)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([name, n]) => ({ name, pct: (n / total) * 100 }));

// The eight shown never sum to 100, so the bar is scaled to what it displays.
const shown = ranked.reduce((a, l) => a + l.pct, 0) || 1;

// The site palette, warm end first so the largest language reads brightest.
const RAMP = ["#ffb020", "#e8a02a", "#c98a2c", "#a8762f", "#8a9099", "#6f757e", "#5c626c", "#464b54"];

const BG = "#0e1015";
const LINE = "#1e222b";
const TEXT = "#e8eaee";
const MUTED = "#8a9099";
const DIM = "#5c626c";
const ACCENT = "#ffb020";

const W = 880;
const H = 268;
const mono = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, monospace";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const stats = [
  { label: "REPOSITORIES", value: own.length },
  { label: "STARS EARNED", value: stars },
  { label: "FORKS", value: forks },
  { label: "FOLLOWERS", value: user.followers },
];
if (commits) stats.splice(2, 0, { label: "COMMITS", value: commits.toLocaleString("en-US") });

const colW = (W - 96) / stats.length;

const statCells = stats
  .map((s, i) => {
    const x = 48 + colW * i;
    return `
    <text x="${x}" y="112" font-family="${sans}" font-size="34" font-weight="600" fill="${TEXT}">${s.value}</text>
    <text x="${x}" y="134" font-family="${mono}" font-size="10" letter-spacing="1.4" fill="${DIM}">${s.label}</text>`;
  })
  .join("");

// Stacked language bar.
let cursor = 48;
const barW = W - 96;
const segments = ranked
  .map((l, i) => {
    const w = Math.max((l.pct / shown) * barW - 2, 2);
    const seg = `<rect x="${cursor.toFixed(1)}" y="176" width="${w.toFixed(1)}" height="10" rx="2" fill="${RAMP[i]}" />`;
    cursor += w + 2;
    return seg;
  })
  .join("");

const legend = ranked
  .map((l, i) => {
    const perRow = 4;
    const x = 48 + (i % perRow) * ((W - 96) / perRow);
    const y = 214 + Math.floor(i / perRow) * 22;
    return `
    <circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${RAMP[i]}" />
    <text x="${x + 16}" y="${y}" font-family="${sans}" font-size="12" fill="${MUTED}">${l.name}</text>
    <text x="${x + 22 + l.name.length * 6.6}" y="${y}" font-family="${mono}" font-size="11" fill="${DIM}">${l.pct.toFixed(1)}%</text>`;
  })
  .join("");

const updated = new Date().toISOString().slice(0, 10);

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub statistics for ${USER}">
  <rect width="${W}" height="${H}" rx="12" fill="${BG}" stroke="${LINE}" />
  <text x="48" y="52" font-family="${mono}" font-size="11" letter-spacing="2" fill="${ACCENT}">GITHUB · ${USER.toUpperCase()}</text>
  <text x="${W - 48}" y="52" text-anchor="end" font-family="${mono}" font-size="10" fill="${DIM}">updated ${updated}</text>
  <line x1="48" y1="68" x2="${W - 48}" y2="68" stroke="${LINE}" />
  ${statCells}
  <text x="48" y="164" font-family="${mono}" font-size="10" letter-spacing="1.4" fill="${DIM}">LANGUAGES BY SHARE ACROSS REPOS</text>
  ${segments}
  ${legend}
</svg>
`);
