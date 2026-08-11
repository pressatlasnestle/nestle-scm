/**
 * A frozen copy of the live keyword taxonomy, read from the SCM database on
 * 2026-08-11: 161 active rows and the 42 `variations` arrays migration 17
 * derived from `notes`.
 *
 * Frozen on purpose. These checks exist to catch a matcher change that moves a
 * capture decision, and a fixture that re-read the live table would move under
 * the checks every time a curator edited a keyword — a failure would no longer
 * tell you whether the code or the data had changed. Refresh it deliberately
 * when the taxonomy changes in a way the checks should track.
 */
const RAW = `2M / THE Alliance|Gate 2 - Topic|positive|Exact phrase
award winner / appointed as / joins board / promoted to|Exclusion|negative|Exact phrase
Bab al-Mandeb|Gate 2 - Topic|positive|Entity
BCO / beneficial cargo owner|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
berth congestion|Gate 2 - Topic|positive|Exact phrase
berth waiting time|Gate 2 - Topic|positive|Exact phrase
bill of lading|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
blank sailing|Gate 2 - Topic|positive|Stem / partial
blockchain shipping / tokenised vessel / maritime NFT|Exclusion|negative|Exact phrase
blood vessel / vessel wall / vessel disease|Exclusion|negative|Exact phrase
box shipping|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
bunker adjustment factor|Gate 2 - Topic|positive|Exact phrase
capacity management|Gate 2 - Topic|positive|Exact phrase
Cape of Good Hope|Gate 2 - Topic|positive|Entity
carbon surcharge|Gate 2 - Topic|positive|Exact phrase
cargo pants / cargo shorts|Exclusion|negative|Exact phrase
carrier alliance|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
carrier bag / mobile carrier / insurance carrier / carrier signal|Exclusion|negative|Exact phrase
CBAM|Gate 2 - Topic|positive|Exact phrase
charter rate|Gate 2 - Topic|positive|Exact phrase
Chinese New Year|Gate 2 - Topic|positive|Exact phrase
CII / EEXI|Gate 2 - Topic|positive|Exact phrase
CMA CGM|Gate 2 - Topic|positive|Entity
Colombo / JNPA / Nhava Sheva / Mundra|Gate 2 - Topic|positive|Entity
conference call for papers / journal issue / research symposium|Exclusion|negative|Exact phrase
congestion surcharge|Gate 2 - Topic|positive|Exact phrase
container image / container registry / containerd|Exclusion|negative|Exact phrase
container shipping|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
container throughput|Gate 2 - Topic|positive|Exact phrase
containers for sale / conex box / storage container rental|Exclusion|negative|Exact phrase
containers overboard|Gate 2 - Topic|positive|Exact phrase
containership|Gate 1 - Domain anchor (REQUIRED)|positive|Stem / partial
COSCO / OOCL|Gate 2 - Topic|positive|Entity
cruise ship / cruise line / passenger ship / ferry service|Exclusion|negative|Exact phrase
customs delay|Gate 2 - Topic|positive|Exact phrase
cyberattack|Gate 2 - Topic|positive|Exact phrase
de minimis|Gate 2 - Topic|positive|Exact phrase
demurrage|Gate 2 - Topic|positive|Exact phrase
dividend|Exclusion|negative|Stem / partial
Docker / Kubernetes / containerisation (software)|Exclusion|negative|Exact phrase
DP World / PSA / Hutchison / APM Terminals / Adani Ports / Eurogate|Gate 2 - Topic|positive|Entity
draft restriction|Gate 2 - Topic|positive|Exact phrase
drone attack / missile strike|Gate 2 - Topic|positive|Exact phrase
dwell time|Gate 2 - Topic|positive|Exact phrase
earnings per share / EPS|Exclusion|negative|Exact phrase
ETS surcharge|Gate 2 - Topic|positive|Exact phrase
EU ETS maritime|Gate 2 - Topic|positive|Exact phrase
Evergreen|Gate 2 - Topic|positive|Entity
Evergreen State / evergreen content / evergreen trees|Exclusion|negative|Exact phrase
export restriction|Gate 2 - Topic|positive|Exact phrase
FCL / LCL|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
FEU|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
fishing vessel / trawler / aquaculture|Exclusion|negative|Exact phrase
fleet growth|Gate 2 - Topic|positive|Exact phrase
fog closure|Gate 2 - Topic|positive|Exact phrase
free shipping / shipping fee / shipping cost (e-commerce)|Exclusion|negative|Exact phrase
freight forwarder|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
freight rate|Gate 2 - Topic|positive|Stem / partial
Freightos Baltic Index|Gate 2 - Topic|positive|Exact phrase
frontloading|Gate 2 - Topic|positive|Exact phrase
FuelEU Maritime|Gate 2 - Topic|positive|Exact phrase
game port / porting a game|Exclusion|negative|Exact phrase
Gemini (Google AI model)|Exclusion|negative|Entity
Gemini Cooperation|Gate 2 - Topic|positive|Exact phrase
general average|Gate 2 - Topic|positive|Exact phrase
general rate increase|Gate 2 - Topic|positive|Exact phrase
green corridor|Gate 2 - Topic|positive|Exact phrase
green methanol / LNG dual-fuel / biofuel bunkering|Gate 2 - Topic|positive|Exact phrase
grounding / collision / allision|Gate 2 - Topic|positive|Stem / partial
Gulf of Aden|Gate 2 - Topic|positive|Entity
Hapag-Lloyd|Gate 2 - Topic|positive|Entity
hiring / vacancy / job opening / career opportunity / recruitment|Exclusion|negative|Exact phrase
HMM / Yang Ming / ZIM / PIL / Wan Hai / X-Press Feeders|Gate 2 - Topic|positive|Entity
Houthi|Gate 2 - Topic|positive|Entity
idle fleet|Gate 2 - Topic|positive|Exact phrase
IMO Net-Zero Framework|Gate 2 - Topic|positive|Exact phrase
index-linked contract|Gate 2 - Topic|positive|Exact phrase
inventory restocking|Gate 2 - Topic|positive|Exact phrase
IPO / SPAC / bond issuance|Exclusion|negative|Exact phrase
is X a buy / should you invest|Exclusion|negative|Exact phrase
Jebel Ali / Jeddah / Durban / Tanger Med|Gate 2 - Topic|positive|Entity
Jones Act claim / seafarer injury / maritime lawyer / personal injury|Exclusion|negative|Exact phrase
labour negotiation|Gate 2 - Topic|positive|Exact phrase
Le Havre / Piraeus / Algeciras / Southampton|Gate 2 - Topic|positive|Entity
liner shipping|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
Los Angeles / Long Beach / San Pedro Bay / Savannah|Gate 2 - Topic|positive|Entity
Maersk|Gate 2 - Topic|positive|Entity
Maersk Growth / Maersk Training (non-liner units)|Exclusion|negative|Exact phrase
maritime logistics|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
MEPC|Gate 2 - Topic|positive|Exact phrase
MSC / Mediterranean Shipping Company|Gate 2 - Topic|positive|Entity
naval vessel / frigate / destroyer / aircraft carrier / submarine|Exclusion|negative|Exact phrase
New York-New Jersey / Vancouver / Santos|Gate 2 - Topic|positive|Entity
newbuilding|Gate 2 - Topic|positive|Stem / partial
news anchor / anchor tenant|Exclusion|negative|Exact phrase
NVOCC|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
Ocean Alliance|Gate 2 - Topic|positive|Exact phrase
ocean freight|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
Ocean Network Express / ONE|Gate 2 - Topic|positive|Entity
offshore wind / oil rig / FPSO / drillship / seismic survey|Exclusion|negative|Exact phrase
on-time performance|Gate 2 - Topic|positive|Exact phrase
ONE (as standalone word)|Exclusion|negative|Exact phrase
orderbook|Gate 2 - Topic|positive|Exact phrase
overcapacity|Gate 2 - Topic|positive|Exact phrase
Panama Canal|Gate 2 - Topic|positive|Entity
peak season|Gate 2 - Topic|positive|Exact phrase
peak season surcharge|Gate 2 - Topic|positive|Exact phrase
piracy / hijacking|Gate 2 - Topic|positive|Stem / partial
port congestion|Gate 2 - Topic|positive|Exact phrase
port forwarding / TCP port / USB port / HDMI port|Exclusion|negative|Exact phrase
port of call|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
port omission|Gate 2 - Topic|positive|Exact phrase
port strike|Gate 2 - Topic|positive|Exact phrase
port wine / Porto / Portsmouth / Port Vale / Portland|Exclusion|negative|Entity
Premier Alliance|Gate 2 - Topic|positive|Exact phrase
price target|Exclusion|negative|Exact phrase
rail disruption|Gate 2 - Topic|positive|Exact phrase
Red Sea|Gate 2 - Topic|positive|Entity
rerouting / diversion|Gate 2 - Topic|positive|Stem / partial
rolled cargo|Gate 2 - Topic|positive|Exact phrase
Rotterdam / Antwerp-Bruges / Hamburg / Bremerhaven|Gate 2 - Topic|positive|Entity
salvage|Gate 2 - Topic|positive|Exact phrase
sanctions / vessel detention|Gate 2 - Topic|positive|Stem / partial
SCFI / CCFI / NCFI|Gate 2 - Topic|positive|Entity
schedule reliability|Gate 2 - Topic|positive|Exact phrase
scrapping / demolition|Gate 2 - Topic|positive|Stem / partial
sea freight|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
Section 301 / USTR port fee|Gate 2 - Topic|positive|Exact phrase
service rotation change|Gate 2 - Topic|positive|Exact phrase
service suspension|Gate 2 - Topic|positive|Exact phrase
Shanghai / Ningbo / Qingdao / Yantian / Shenzhen|Gate 2 - Topic|positive|Entity
share price|Exclusion|negative|Exact phrase
shipping (fandom) / shipping couples|Exclusion|negative|Exact phrase
shipping container home / container house / container cafe|Exclusion|negative|Exact phrase
shipping line|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
short interest|Exclusion|negative|Exact phrase
Singapore / Port Klang / Tanjung Priok / Laem Chabang / Surabaya|Gate 2 - Topic|positive|Entity
slow steaming|Gate 2 - Topic|positive|Exact phrase
Strait of Hormuz|Gate 2 - Topic|positive|Entity
Strait of Malacca|Gate 2 - Topic|positive|Entity
Suez Canal|Gate 2 - Topic|positive|Entity
Suez Crisis 1956 / Panama Papers / Titanic / maritime museum|Exclusion|negative|Entity
superyacht / marina / recreational boating / sailing regatta|Exclusion|negative|Exact phrase
tanker charter / VLCC / crude freight rate|Exclusion|negative|Exact phrase
tariff|Gate 2 - Topic|positive|Stem / partial
terminal illness / computer terminal / bus terminal / airport terminal|Exclusion|negative|Exact phrase
terminal operator|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
TEU|Gate 1 - Domain anchor (REQUIRED)|positive|Exact phrase
top 10 tips / ultimate guide / how to choose / beginner's guide|Exclusion|negative|Exact phrase
transit advisory|Gate 2 - Topic|positive|Exact phrase
transit time|Gate 2 - Topic|positive|Exact phrase
typhoon / cyclone / hurricane|Gate 2 - Topic|positive|Entity
ULCV / megamax|Gate 2 - Topic|positive|Exact phrase
vehicle fleet / fleet management (road)|Exclusion|negative|Exact phrase
vessel bunching|Gate 2 - Topic|positive|Exact phrase
vessel fire|Gate 2 - Topic|positive|Exact phrase
war risk surcharge|Gate 2 - Topic|positive|Exact phrase
webinar / whitepaper download / sponsored content / advertorial|Exclusion|negative|Exact phrase
World Container Index|Gate 2 - Topic|positive|Exact phrase
Xeneta XSI|Gate 2 - Topic|positive|Exact phrase
yard utilisation|Gate 2 - Topic|positive|Exact phrase`;

/** keywords.variations as written by migration 17, read back from the DB. */
const VARIATIONS: Record<string, string[]> = {
  "Bab al-Mandeb": ["Bab el Mandab", "Bab-el-Mandeb"],
  "berth congestion": ["anchorage congestion"],
  "berth waiting time": ["anchorage waiting", "vessel waiting time"],
  "blank sailing": ["blanked sailing", "void sailing"],
  "bunker adjustment factor": ["BAF", "CAF"],
  "capacity management": ["capacity withdrawal"],
  "charter rate": ["time charter equivalent"],
  "Chinese New Year": ["Golden Week"],
  "congestion surcharge": ["emergency surcharge"],
  "container throughput": ["box volumes", "import volumes", "TEU throughput"],
  "containers overboard": ["container loss"],
  containership: ["container ship", "container vessel", "containerships"],
  "customs delay": ["customs clearance backlog"],
  cyberattack: ["port systems outage", "ransomware"],
  demurrage: ["D&D charges", "detention"],
  dividend: ["share repurchase"],
  "draft restriction": ["drought restriction", "low water"],
  "earnings per share / EPS": ["earnings call", "quarterly results"],
  "export restriction": ["export control"],
  "fleet growth": ["capacity growth", "effective capacity"],
  "freight rate": ["contract rate", "spot rate"],
  "Freightos Baltic Index": ["FBX"],
  frontloading: ["front-loading", "pull-forward"],
  "general rate increase": ["GRI"],
  "idle fleet": ["idle capacity", "idled tonnage"],
  "labour negotiation": ["labor negotiation"],
  newbuilding: ["newbuild delivery"],
  "on-time performance": ["OTP"],
  "peak season surcharge": ["PSS"],
  "port omission": ["omitted call", "port skip"],
  "port strike": ["dockworker strike", "industrial action", "lockout"],
  "price target": ["analyst rating", "buy rating", "hold rating"],
  "rerouting / diversion": ["re-route", "transit diversion"],
  "rolled cargo": ["cargo rollover", "rollover rate"],
  "service rotation change": [
    "loop change",
    "network reshuffle",
    "string change",
  ],
  "share price": ["market cap", "stock price"],
  "short interest": ["insider selling", "institutional holdings"],
  "transit advisory": ["convoy", "escort"],
  "vessel fire": ["cargo fire", "containership fire"],
  "war risk surcharge": ["war risk premium"],
  "World Container Index": ["Drewry index", "WCI"],
  "yard utilisation": ["yard utilization"],
};

export type TaxonomyRow = {
  id: string;
  keyword: string;
  gate: string | null;
  list_type: string;
  match_type: string | null;
  notes: string | null;
  variations: string[] | null;
  is_active: boolean;
  created_at: string;
  added_by: string | null;
  cluster: string | null;
};

export const TAXONOMY: TaxonomyRow[] = RAW.split("\n").map((line, i) => {
  const [keyword, gate, list_type, match_type] = line.split("|");
  return {
    id: `k${i}`,
    keyword,
    gate: gate || null,
    list_type,
    match_type: match_type || null,
    notes: null,
    variations: VARIATIONS[keyword] ?? null,
    is_active: true,
    created_at: "2026-08-11T00:00:00Z",
    added_by: null,
    cluster: null,
  };
});
