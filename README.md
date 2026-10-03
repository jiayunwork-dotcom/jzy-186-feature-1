# 温室气体核算后端（GHG Accounting Backend）

把每一个披露数字的来龙去脉都留下来的核算后端：版本化因子库、可更正的活动数据、
精确有理数运算、任意两口径的重述差额分解、基准年显著性判定、月度关账快照与
逐数字追溯。

技术栈：**Node.js 20 + TypeScript + NestJS + PostgreSQL 16**，测试用 **Jest**，
部署用 **Docker Compose**（应用镜像基于 `node:20-slim`，数据库 `postgres:16-alpine`，
数据卷持久化）。

---

## 1. 目录与模块

```
src/
  common/          精确有理数 Fraction、错误类型、HTTP 异常过滤器、序列化
  units/           单位换算（质量/体积/能量，经密度与热值跨量纲换算）
  database/        pg 连接池、事务封装、迁移执行器
  migrations/      0001_schema.sql、0002_transfers.sql（内部转供）
  master-data/     厂区、排放源、产能设施、用能点主数据
  factor-library/  因子库版本、燃料密度/热值、载体参考效率、因子适用期、GWP 集合
  activity-data/   活动数据批量导入、更正链、活动数据截止点（cut）
  transfer/        产出/转供登记（可更正）与精确转供分摊引擎
  accounting/      核算引擎（纯函数）+ 口径装载服务
  company/         厂区视角与公司抵消视角
  restatement/     两口径对比、Shapley 三因素分解、基准年显著性
  close/           月度关账与披露快照（含快照级追溯行）
  lineage/         来源因子解释、转供链路追溯、更正反向影响
  interfaces/      NestJS 控制器（HTTP 接口）
test/              7 个测试文件、51 个用例
```

---

## 2. 三个核心设计决定（审计最关心的部分）

### 2.1 精确有理数：所有数字用 `bigint` 分子/分母，不用浮点

`src/common/fraction.ts`。活动量、换算后的能量、每种气体的质量、CO2e、
所有汇总、分解的三个分量，端到端都是约分后的有理数。十进制输入（`56.1`、
`0.0001`、`1e3`）被精确解析；因子/GWP 都是有限小数，分母只含因子 2、5，
所以所有结果都是**有限小数，可精确展示**。

由此得到三条审计性质：

1. **同一口径永远逐位相同**——不存在求和顺序相关的浮点漂移；引擎仍按
   `record_no → gas` 的固定顺序累加，连约分后的规范形式都一致。
2. **三部分之和严格等于总差额**——分量与总额用同一套分数加法，
   `activity + factors + gwp ≡ total` 是代数恒等式，逐位相等，不是“误差内相等”。
3. **单位换算往返不变**——`m3 → GJ → m3` 精确还原输入（密度与热值也是分数）。

数据库里所有计量值存为 `value_num bigint, value_den bigint`，**绝不在 SQL 里
对计量值做 SUM**；求和全部在应用层按固定顺序完成。

### 2.2 口径（caliber）= 活动数据截止点 + 因子版本 + GWP 集合

三者都是**不可变对象**：

- **因子版本/GWP 集合**：只追加，一经发布不可改。新版本永远是新的 `id`，
  不可能影响任何旧口径。
- **活动数据截止点（cut）**：一个不可变时间戳 `as_of`。某时刻的有效记录集
  完全由它推导（见 2.4），所以不需要为每次查询复制活动数据。

口径一旦确定，任何时候、用任何方式查询，结果都相同。

### 2.3 重述分解：选择 Shapley 值（全顺序平均），不用固定顺序

记结果函数 `f(A, F, G)`，基准口径 `(A0,F0,G0)`，新口径 `(A1,F1,G1)`。
三因素相互作用时，固定顺序逐项替换（Laspeyres 式）会把交互项归给“最后换的
那个因素”，顺序不同分解就不同——这正是审计质疑“按不同顺序结果不一样”的根源。

本系统采用 **Shapley 值分解**：每个因素分到它在全部 3! = 6 种替换顺序下
边际贡献的平均值。等价地，只需要立方体 8 个角点各算一次：

```
phi_A = 1/6 ( 2f100 + f110 + f101 + 2f111 − 2f000 − f010 − f001 − 2f011 )
phi_F = 1/6 ( 2f010 + f110 + f011 + 2f111 − 2f000 − f100 − f001 − 2f101 )
phi_G = 1/6 ( 2f001 + f101 + f011 + 2f111 − 2f000 − f100 − f010 − 2f110 )
```

**公平性**：Shapley 是唯一同时满足三条公理的分摊——对称性（作用相同的因素
分得相同）、哑元性（不起作用的因素分得 0）、可加性。每种因素在每个角点上
权重对称，交互项被公平地对半/按组合权重切开。

**计算代价**：8 次角点计算，而不是固定顺序法的 4 次，最多多一倍。每个角点
只是对已装载记录做一次 bigint 扫描，无近似、无蒙特卡洛，结果确定可复现。
（`src/restatement/decomposition.ts`）

两个直接推论，都有测试锁定：

- 只换 GWP 集合时，CO2/CH4/N2O 的**气体质量**完全不变（`phi_G` 为 0），
  只有 CO2e 变化；
- `phi_A + phi_F + phi_G = f111 − f000` 对 CO2、CH4、N2O、CO2e 四个指标
  全部逐位成立。

### 2.4 活动数据、更正链与截止点

- 活动记录按**厂区 / 排放源 / 月份**登记，带唯一 `record_no`，原记录永不删除。
- 更正是**一条带新编号的新记录**，`supersedes_record_no` 指向被更正记录。
  每条记录最多被更正一次：
  - 业务层校验“目标不存在 / 已被更正”；
  - 数据库部分唯一索引 `activity_one_correction_per_record`
    （`WHERE supersedes_record_no IS NOT NULL`）是最终并发防线——
    **两条更正并发提交时，数据库只接受一条，另一条得到唯一键冲突（409）**。
- 同一 `record_no` 重复提交：内容相同记为 `duplicate` 不重复计数；
  内容不同直接拒绝。
- 截止点 `c` 处的有效记录集（`getEffectiveRecords`）：

  ```sql
  r.created_at <= c.as_of
  AND NOT EXISTS (更正 s：s.supersedes_record_no = r.record_no AND s.created_at <= c.as_of)
  ```

  即“每条更正链在该时点可见的链头”。截止点之后提交的更正即使更正的是
  旧记录，也不可见。

### 2.5 基准年重算规则

`POST /restatements/compare` 带 `baseYear` 时，计算

```
changeRatio = |新口径 CO2e − 基准口径 CO2e| / |基准口径 CO2e|
```

当 `changeRatio > threshold`（默认 **0.05**，严格大于；可传
`significanceThreshold` 覆盖）时：

- 在 `base_year_flags` 中把基准年标记为 `needs_recalc = true`（upsert）；
- 无论是否触发，都在 `restatement_notes` 写一条说明，含两个口径、新旧总量、
  变化率、阈值、触发结果与文字说明。

### 2.6 计算结果怎么存：按需现算 + 关账物化，两者共享同一引擎

- **日常口径查询（`/accounting/summary`、`/restatements/compare`、
  `/lineage/explain`）按需现算**。因为口径三要素全部不可变，且运算是精确
  分数，现算结果与“全量重算”天然一致，且永远相同，无需物化失效维护。
- **只有月度关账显式物化**一份对外披露快照（`snapshot_rows` 每行还带
  `snapshot_lineage` 因子血缘）。快照行一旦写入不再重算。

月度关账的隔离语义（“关账进行中若有人发布新因子或提交更正，关账只认开始
那一刻的数据”）：

1. 关账在 **REPEATABLE READ** 事务中进行；
2. 事务内取**事务开始时间** `now()`（即 `transaction_timestamp()`）创建 cut，
   因此有效记录查询的 `created_at <= as_of` 边界与事务快照是同一时刻——
   关账期间提交的更正既进不了快照，也进不了未来按该 cut 的重算，二者一致；
3. 因子/GWP 用固定的不可变 `id` 引用，期间发布的新版本是另一个 `id`，
   不可能被本次关账读到；
4. 同粒度（公司级/厂区级 × 月份）用事务级咨询锁串行化，重复关账返回
   `ALREADY_CLOSED`。

快照写完后再发布因子、提交更正、补录晚到数据，都不会改变快照（有测试）。

---

## 3. 单位换算（`src/units`）

- 同量纲用精确十进制常量：`1 t = 1000 kg`，`1 L = 0.001 m³`，
  `1 kWh = 0.0036 GJ`（`1 MWh = 3.6 GJ`）。
- 跨量纲经由**因子库中该版本**的燃料物性：
  - 密度 `kg/m³`（体积 ↔ 质量）；
  - 热值 `GJ/t`（质量 ↔ 能量）；
  - 体积↔能量由两者派生（`density × ncv / 1000` GJ/m³），不单独存第三个数，
    两条路径不会漂移。
- 密度/热值随因子版本发布，因此它们的更新在重述分解中属于**因子变化**。
- 因子单位形如 `kg/GJ`、`kg/m3`、`kg/kWh`：分子必须是质量单位，分母是活动
  单位。核算时活动量被精确换算到因子分母单位，再乘因子并换算成吨。

---

## 4. 校验（全部指出具体字段）

| 场景 | HTTP | `code` | 字段位置示例 |
|---|---|---|---|
| 数量为负 / NaN / Infinity | 400 | `NEGATIVE_OR_NON_FINITE` | `records[i].quantity` |
| 单位未知 | 400 | `UNKNOWN_UNIT` | `records[i].unit` |
| 单位无法换算到因子单位 | 400 | `UNIT_NOT_CONVERTIBLE` | `records[i].unit` |
| 月份不在因子适用期内 | 400 | `MONTH_OUTSIDE_FACTOR_PERIOD` | `records[i].month` |
| 更正目标不存在 | 400 | `CORRECTION_TARGET_MISSING` | `records[i].supersedesRecordNo` |
| 更正目标已被更正（含并发落败方） | 400 / **409** | `CORRECTION_TARGET_ALREADY_CORRECTED` / `CORRECTION_CONFLICT` | 同上 |
| 因子适用期重叠 | 400 | `FACTOR_PERIOD_OVERLAP` | `factors`（数据库 GiST 排他约束兜底） |
| 同一编号内容不同 | 400 | `DUPLICATE_KEY` | `records[i].recordNo` |
| 排放源未登记 / fuelKey、scope 不一致 | 400 | `NOT_FOUND` / `INVALID_VALUE` / `SCOPE_MISMATCH` | 对应字段 |

批量导入逐条回报 `{ recordNo, status: accepted|duplicate|rejected, errors[] }`，
非法记录不影响其余记录（整批在一个事务里，但拒绝的行不插入；接受的行一起
提交）。

---

## 5. HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `POST /master-data/sites`、`POST /master-data/sources` | 厂区 / 排放源主数据（upsert，源可带 `facilityCode`） |
| `POST /master-data/facilities`、`POST /master-data/use-points` | 产能设施 / 用能点（内部转供，见 §9） |
| `POST /factor-versions` | 发布因子库版本（燃料物性 + 三气体因子 + 适用期 + 可选载体参考效率） |
| `GET /factor-versions` | 版本列表 |
| `POST /gwp-sets`、`GET /gwp-sets` | 发布 / 列出 GWP 集合（AR5、AR6…） |
| `POST /activity-records/import` | 批量导入（逐条回报；可带 `validateAgainstFactorVersion`） |
| `POST /activity-records/correct` | 更正一条（并发落败返回 409） |
| `GET /activity-records/:recordNo` | 查单条记录 |
| `POST /activity-records/cuts` | 创建截止点（不传 `asOf` 即“当前已提交的全部”） |
| `GET /activity-records/cuts/:id` | 查截止点 |
| `POST /energy-outputs/import`·`/correct`、`POST /energy-transfers/import`·`/correct` | 月度设施产出 / 内部转供登记与更正 |
| `POST /accounting/summary` | 按口径汇总；行带 `category`（DIRECT/TRANSFER） |
| `POST /accounting/company-report` | 公司视角：抵消前各厂合计、内部抵消额、净额 |
| `POST /accounting/transfer-trace` | 转供范围二数字正向追到原始燃料/因子 |
| `GET /accounting/snapshot-impact/:recordNo` | 更正对已关账快照的反向影响（只读） |
| `POST /restatements/compare` | 两口径对比 + Shapley 分解；可带 `baseYear`/阈值 |
| `GET /restatements/base-year-flags/:year` | 基准年标记 |
| `GET /restatements/notes?baseYear=` | 重述说明记录 |
| `POST /closes` | 月度关账，生成披露快照 |
| `GET /closes/:id` | 关账元数据（锁定的 cut/因子/GWP） |
| `GET /closes/:id/snapshot` | 快照数字（带 `category`） |
| `GET /closes/:id/lineage`、`GET /closes/:id/transfer-lineage` | 快照直接血缘 / 转供血缘 |
| `POST /lineage/explain` | 任意口径汇总数字由哪些记录、因子、转供来源得出 |

数字出参统一为 `{ "decimal": "5.61", "num": "561", "den": "100" }`：
`decimal` 用于展示，`num/den` 用于逐位相等的断言。

### 最小算例

```bash
# 某月燃料消耗 100 GJ，CO2 因子 56.1 kg/GJ
# → CO2 = 100 × 56.1 kg = 5610 kg = 5.61 t
```

请求体（因子）：
```json
{"version":"FV1","fuels":[{"fuelKey":"natural_gas","density":"0.8","ncv":"45"}],
 "factors":[{"fuelKey":"natural_gas","gas":"CO2","scope":1,"value":"56.1",
             "unit":"kg/GJ","validFrom":"2023-01","validTo":"2025-12"}, ...]}
```
活动记录 `"quantity":"100","unit":"GJ"`，汇总返回
`co2Tonnes.decimal = "5.61"`（num/den = 561/100）。

---

## 6. 测试（Jest，51 个用例，7 个文件）

- `fraction.spec.ts`：5.61 t 算例、精确解析、严格相等；
- `units.spec.ts`：SI 换算精确、密度+热值跨量纲**往返不变**、缺物性时报错；
- `accounting.spec.ts`：5.61 t；**厂区合计=各排放源之和、年合计=各月之和**；
  同一口径重复计算逐位相同；追溯解释；
- `restatement.spec.ts`：**三部分之和严格等于总差额**（四个指标）；
  Shapley 交互项对半；**只换 GWP 时 CO2/CH4/N2O 不变**；6% 变化触发基准年
  标记并生成说明；未超阈值不标记；
- `close.spec.ts`：关账后发布新因子、提交更正、补录均**不影响快照**；
  快照与按关账口径全量重算一致；快照血缘；重复关账被拒；
- `activity-data.spec.ts`：逐条校验（负/非有限数、单位不可换算、月份超期、
  更正目标缺失/已更正、因子期重叠）；**并发更正只接受一个**；
  **重复提交幂等不重复计数**；更正链在 cut 处取链头。
- `transfer.spec.ts`：**14.025 t 手算例**（东厂范围一仍 56.1 t）；任一设施
  投入排放=各项产出分摊之和逐位相等；参考效率热电切分；东西厂区**成环可解
  且守恒**；**全闭环无最终用途时报错并点名设施**；只换 GWP 转供链路气体质量
  不变；只换因子→西厂变化全归因子分量、只更正东厂燃料→全归活动分量；跨厂
  正向追溯（含环路径有限展开+精确份额）；反向影响列出仅经转供受影响的厂区；
  关账后上游更正不动下游快照；超量转供/自转/缺用能点/单位不可换算/有转供无
  产出/产出调低致超量等逐条字段校验；**无转供数据时结果与旧引擎逐位一致**；
  关账快照含 TRANSFER 行与转供血缘。

集成测试共用一个 PostgreSQL 库、每个测试文件持有独立连接池，因此 Jest 配置
固定 `maxWorkers: 1`（即 `--runInBand`），避免跨文件的 `TRUNCATE ... RESTART
IDENTITY` 与未提交 DML 发生锁死；这也保证了求和与测试顺序的确定性。

```bash
npm install
npm test                 # 需先有一个可连的 PostgreSQL（见下）
DATABASE_URL_TEST=postgres://user@host:5432/ghg_test npm test
```

---

## 7. 本地运行与 Docker Compose 部署

```bash
docker compose up --build
# db:  postgres:16-alpine，库 ghg，命名卷 pgdata 持久化
# api: node:20-slim 多阶段构建，启动时自动执行迁移，监听 :3000
```

应用容器启动命令为 `node dist/migrations/run.js && node dist/main.js`：
迁移幂等（`schema_migrations` 记录已应用文件）。

不用容器时：

```bash
createdb ghg
DATABASE_URL=postgres://postgres@localhost:5432/ghg npm run migrate
npm run build && npm start
```

环境变量：`DATABASE_URL`（默认 `postgres://postgres@localhost:5432/ghg`）、
`PORT`（默认 3000）、`PG_POOL_MAX`。无前端页面。

---

## 8. 数据模型要点

- `emission_factors` 上的 **GiST 排他约束**排除同版本同燃料/气体/范围适用期
  重叠（相邻期间允许）；
- 因子版本、GWP 集合只追加，外键 `ON DELETE` 仅用于级联清理，业务上不删除；
- `snapshot_rows` 主键为 `(close_id, site, source, month, scope, gas, category)`，
  含 `CO2/CH4/N2O/CO2E` 四行；`snapshot_lineage` 按 `(close_id, record_no, gas)`
  记录因子 id、换算到因子单位的活动量、气体质量；
- 所有 id 用 `integer GENERATED ALWAYS AS IDENTITY`；计量值分子分母用 `bigint`。

---

## 9. 内部转供（厂区间蒸汽 / 电量往来）

内部能量往来的完整设计。锅炉房、汽轮机等**产能设施**每月登记产出（蒸汽 /
电 / 热水等载体）和送往其他厂区用能点的转供量；投入设施的燃料燃烧和外购
电仍是普通活动记录，其排放沿转供网络精确分摊到最终用户。

### 9.1 数据对象

| 对象 | 表 | 说明 |
|---|---|---|
| 产能设施 | `facilities` | 唯一编码，归属唯一厂区 |
| 用能点 | `energy_use_points` | 厂区内的交付点；可挂接一个设施（汽轮机入口），也可以是最终用途（空） |
| 载体参考效率 | `carrier_efficiencies` | **随因子版本发布**，每个载体一个 (0,1] 的参考效率 |
| 月度产出 | `energy_outputs` | 设施 × 月 × 载体，单位必须是能量单位（精确换算到 GJ） |
| 月度转供 | `energy_transfers` | 设施 → 厂区/用能点 × 月 × 载体 |
| 设施投入 | `activity_records`（源挂 `facility_code`） | 该设施烧掉的燃料、用的外购电等 |

产出和转供记录与活动记录完全同一套纪律：唯一 `record_no`、内容一致的重复
提交返回 `duplicate` 不重复计数、更正为带 `supersedes_record_no` 的新记录
（部分唯一索引保证一条记录最多被更正一次，并是并发的最后防线）、截止点可见
集只含 `created_at <= as_of` 且链头未被取代的记录——所以关账快照只认关账
开始那一刻之前提交的产出和转供。

### 9.2 分摊方法：参考效率法（决定）

一座热电联产设施同时供热和发电时，三种候选切法的取舍：

- **按能量含量切**（每 GJ 等价）：电的品位远高于热，会把过多排放压给热用户，
  对电用户有利；
- **按可用能/做功切**：方向相反，惩罚热用户；
- **参考效率法（本系统采用）**：每种产品按它来自一台独立参考机组时的效率
  折算，权重 `w_c = Q_c / η_c`，份额 `p_fc = w_c / Σ w_c′`。这是 GHG
  Protocol、ISO 14064-1 与 IEA 对热电联产的标准折中：热用户按供热参考效率
  （蒸汽约 0.9）承担，电用户按发电参考效率（约 0.4）承担，两边都不被
  系统性偏袒。

**参数从哪来、要不要随因子库发布：** `η_c` 存为因子版本的一部分
（`carrier_efficiencies`）。它本质上是分配参数，必须与因子同版本冻结：换
参考效率就是一次因子库变更，在两口径差额分解中整额落在「因子」分量；核算
绝不会在运行期偷偷换分母。产出某载体但该版本没有对应 η 时，核算明确报错
（`CARRIER_EFFICIENCY_MISSING`），不静默给数。

### 9.3 网络方程与成环求解

月份之间彼此独立。设施 f 送出的每条边（载体 c、能量 q）携带其当前**累积
责任** `E_f` 的 `p_fc·q/Q_fc`。累积责任满足

```
E_f = D_f + Σ_进入设施的边 边携带量
```

即线性方程组 `(I − M)E = D`，其中 `M[to][from]` 是发送方输出按参考效率
份额流出到接收设施的精确比例。

- **查单个厂区算不算整张网：** 算。一次求解全公司当月全部设施（按编码
  确定顺序），任何厂区数字都是同一组精确解的投影；没有逐步近似，也就没有
  路径截断误差。
- **精确性：** M 与解全是约分分数，高斯-若尔当消元选主元顺序固定，结果
  是精确有理数，同一口径重复查询逐位一致。分母只含因子/效率/能量比值的
  2、5 因子时为有限小数；否则分数原样保留。
- **全闭环、无最终用途：** 若一组设施的全部产出只在彼此间循环（没有任何
  边落到不挂设施的用能点，也没有任何产出留存自用），(I−M) 奇异。系统先用
  反向可达性把这批设施点名出来，抛 `TRANSFER_NETWORK_NO_FINAL_USE` 并列明
  设施编码，不卡死、不除零。
- **开销：** 每月对 n 个设施做一次 O(n³) 精确消元和 O(边数) 扫描；厂区/
  关系变多以后是立方增长，但矩阵小、元素为分数且纯内存，且每口径只算一次。

### 9.4 范围归属与厂区 / 公司两视角

- **生产者厂区：** 燃料燃烧的范围一全额留在生产厂区（例子里东厂范围一
  始终 56.1 t，送出蒸汽不减 Scope 1）。
- **接收方厂区：** 每收到一次内部能量就在接收厂区记一条**范围二、类别
  TRANSFER** 的虚拟记录（来源标记为 `TRANSFER:<用能点>`，与外购电的范围二
  DIRECT 行天然分开）。西厂收到的 200 GJ 蒸汽：唯一载体时份额即能量比
  200/800，CO₂ = 56.1 × 1/4 = **14.025 t**。
- **公司视角：** 厂区视角相加会把内部能量算两遍；公司合并只做一件事——
  减去全部内部转供的范围二镜像。`POST /accounting/company-report` 同时给
  抵消前各厂合计 `gross`、抵消额 `internalElimination` 和抵消后 `net`，
  差额一目了然。净结果等于原始燃烧各算一次：净 56.1 t。
- **守恒恒等式（逐位）：** Σ 设施投入 D 的某气体质量 = Σ 落到最终用能点
  的边 + Σ 留存产出。设施间的边是中间流，不计入最终用途。
- **只改转供量：** 燃料与外购电不变时，公司净合计逐位不变；变化只在厂区
  之间与抵消额之间移动（此消彼长）。

### 9.5 差额分解、追溯与关账

- **Shapley 分解照常成立。** 转供网络只是口径求值的一部分：只换因子版本
  （含 η）时西厂转供范围二的变化整额落在「因子」分量；只更正东厂燃料记录
  时，西厂经由转供受到的影响整额落在「活动」分量（有测试锁定）。换 GWP
  集合时三气体质量在转供链路上逐位不变，只有 CO2e 变。
- **正向追溯：** `POST /accounting/transfer-trace` 从一个接收方范围二数字
  一路追到东厂原始燃料记录与所用因子，每一跳带精确分摊系数。成环时走一条
  确定性 BFS 简单路径（不无限展开），并给出该路径系数 `pathShare` 与精确
  总份额 `exactShare`，两者之比即环的循环放大系数。
- **反向影响：** `GET /accounting/snapshot-impact/:recordNo` 回答“某条记录
  更正后，哪些**已关账**快照按最新数据重算会变”，区分直接受影响
  （DIRECT）与仅经由转供受影响的厂区（TRANSFER）。它是只读查询：快照本身
  永不改写。
- **关账语义不变：** 关账在 REPEATABLE READ 事务内锁定 cut/因子/GWP，关账
  之后东厂补报或更正，西厂已关账快照纹丝不动。迁移只给 `snapshot_rows`
  增加分类列（旧行盖 DIRECT，旧主键重建为含 category 的新主键），旧快照与其
  血缘不重算、不改写；新关账额外把转供血缘写入 `snapshot_transfer_lineage`。
- **校验（都指到具体字段）：** 转供超过当月产出 `TRANSFER_EXCEEDS_OUTPUT`；
  转给设施自身入口 `TRANSFER_TO_SELF`；目标厂区/用能点不存在 `NOT_FOUND`；
  产出/转供单位不是可换算到 GJ 的能量单位 `UNIT_NOT_CONVERTIBLE`；某月有
  转供却无产出 `TRANSFER_WITHOUT_OUTPUT`（登记批量校验拦截，核算时再兜底，
  相关月份核算直接报错，绝不悄悄给错数）；产出被更正调低到已转供量以下，
  批量记账即拒绝且核算报错。

### 9.6 新增接口

| 方法与路径 | 说明 |
|---|---|
| `POST /master-data/facilities` | 登记产能设施（编码、所属厂区） |
| `POST /master-data/use-points` | 登记用能点（可挂接设施） |
| `POST /master-data/sources` | 排放源新增可选 `facilityCode`（设施投入） |
| `POST /factor-versions` | 新增可选 `carriers: [{carrier, refEfficiency}]` |
| `POST /energy-outputs/import` · `/correct` | 月度产出登记 / 更正 |
| `POST /energy-transfers/import` · `/correct` | 月度转供登记 / 更正 |
| `POST /accounting/company-report` | 厂区合计 / 内部抵消额 / 公司净额 |
| `POST /accounting/transfer-trace` | 转供范围二数字的正向链路追溯 |
| `GET /accounting/snapshot-impact/:recordNo` | 更正对已关账快照的反向影响 |
| `GET /closes/:id/transfer-lineage` | 快照度存的转供血缘 |
| `/accounting/summary`、`/lineage/explain` | 行新增 `category`（DIRECT/TRANSFER），explain 增加转供贡献 |

### 9.7 平滑升级

- 库里没有任何产出/转供记录时，全部叶子都是 DIRECT，现有所有接口结果与
  升级前逐位一致（有专门测试锁定）；
- `0002_transfers.sql` 只加表与可空/带默认值的列，随应用启动自动迁移；
- 升级前已关账的快照及其血缘一行不改写、不重算。

## 10. 测试（Jest，51 个用例，7 个文件）
