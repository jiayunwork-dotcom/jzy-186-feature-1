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
  migrations/      0001_schema.sql、0002_transfers.sql（全部表、约束）
  master-data/     厂区、排放源、产能设施、用能点主数据
  factor-library/  因子库版本、燃料密度/热值、排放因子适用期、GWP 集合、
                   热电分摊参考效率（随版本发布）
  activity-data/   活动数据批量导入、更正链、活动数据截止点（cut）
  transfer/        设施产出与内部转供记录、精确网络求解（环/分摊）、
                   转供层装载、正向追溯与反向影响
  accounting/      核算引擎（纯函数）+ 口径装载服务（含厂区/公司视角抵消）
  restatement/     两口径对比、Shapley 三因素分解、基准年显著性
  close/           月度关账与披露快照（含活动行与转供行两类快照血缘）
  lineage/         活动数据汇总数字的来源记录与因子解释
  interfaces/      NestJS 控制器（HTTP 接口）
test/              7 个测试文件、53 个用例
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

### 2.7 内部转供：登记、分摊、成环、抵消

厂区之间互相送蒸汽/电以前无处登记，同一笔天然气燃烧在公司层面被算两遍。
0002 迁移与 `src/transfer/` 补齐这块，全部沿用前面的六条审计性质。

**登记（设施、用能点、产出、转供）**

- `facilities`：产能设施（锅炉房、汽轮机……），归属于厂区；排放源主数据
  可填 `facilityCode` 把燃料燃烧/外购电活动归到设施，作为它的投入。
- `delivery_points`：用能点，属于厂区。点**绑定设施**时，送到该点的能量
  作为该设施的投入再次进入分摊；不绑定时，送达即该厂区的最终用能，
  嵌入排放在此作为范围二落账。
- `energy_outputs`（每月每设施每载体一条有效产出）与 `energy_transfers`
  （设施 → 他厂用能点）与活动数据**同一套规矩**：唯一 `record_no`、
  原行保留、更正是带新编号的新记录（每记录至多一次更正，部分唯一索引
  并发兜底）、相同内容重复提交为 `duplicate` 不重复计数、cut 处只看
  `created_at <= as_of` 且无可见后继的链头。
- 能量一律精确换算成 GJ（`GJ/MJ/kWh/MWh`），换算不到 GJ 的单位直接
  拒绝（`ENERGY_UNIT_NOT_CONVERTIBLE`）。

**分摊方法：参考效率法（q/η，随因子库版本发布）**

一座设施同时产电和蒸汽时，三气体质量先按载体权重分摊到产出，再随能量
走向下游。载体 c 的分摊权重是

```
w_c = q_c / η_c,    分摊份额 = w_c / Σ w_c′
```

- **对热用户公平**：按热的基准效率 η_蒸汽=η_热水=0.90 计费，热用户不必
  为发电侧的低效率"贴补"电用户；
- **对电用户公平**：按发电基准效率 η_电=0.45（与 EU ETS CHP 协调参考值
  同一量级）计费，正是热电联产"避免外购电网电"的口径；
- 单载体时 η 严格约掉，自动退化成纯能量比例——14.025 t 算例即如此；
- η 是**因子库参数**：发布版本时可用 `referenceEfficiencies` 覆盖，
  因此改 η 在重述分解里属于**因子变化**；不发布就用固定默认值，旧口径
  逐位不变。

纯能量切分会系统性高估热用户（把发电的低效率摊给热）；可用能（㶲）切分
则相反。参考效率法取两者之间、且参数透明可审、与单一载体退化相容。

**线性模型与成环（精确，不迭代不近似）**

按月、按每种气体，设施池 T = 一次投入 P + 从别厂收来的嵌入排放：

```
T = P + B·T   ⇒   (I − B) T = P
```

B 由每条转供的份额 `(q/η_c)/Σw` 构成。系统对每月经一次**精确有理数
Gauss–Jordan 消元**求 (I−B)⁻¹（三气体共用一次逆矩阵）：

- 东西两厂成环时直接得到闭式解，守恒（自用量 + 各最终用能点 = 一次
  投入之和，逐位相等，有测试）；
- `(I−B)⁻¹[r][p]` 是产出者 p 的一次投入最终进入接收者 r 池子的精确
  比例，环的所有循环效应已折叠进这一个系数——追溯不沿环展开，不会
  无限循环；
- 全闭环（一组设施的产出全部在组内来回送、无任何最终用能）时，先用
  Tarjan SCC（O(V+E)）判定，再由消元缺主元兜底，返回
  `CLOSED_LOOP_NO_FINAL_USE`（HTTP 422）并**点名是哪几个设施**和月份，
  不会卡住、不会除零。

复杂度：按月 n 个设施，Tarjan O(V+E) + 消元 O(n³) 次分数运算（只算一次、
三气体共享）；查单个厂区也加载整张当月网络（记录规模下代价可忽略，
且保证跨厂区守恒口径唯一）。厂区/关系增多时按月独立求解，代价随月份
线性、月内立方增长；大网可在设施层做分块但当前不需要。

**手算例子（有测试锁成 561/40）**

东厂锅炉房烧天然气 1000 GJ，CO₂ 因子 56.1 kg/GJ → 56.1 t；产蒸汽
800 GJ，送西厂 200 GJ，当月无从西厂收电。单载体 η 约掉：

```
西厂转供范围二 CO₂ = 56.1 × 200/800 = 14.025 t
东厂范围一 CO₂    = 56.1 t（自用部分留在本厂）
```

三气体质量各自沿链路传递，CO2e 只在末端按口径 GWP 集合折算；所以
"只换 GWP 集合时转供链路上 CO₂/CH₄/N₂O 质量逐位不变"同样成立（有测试）。

**厂区视角 vs 公司视角**

- 厂区汇总：接收方最终用能点上的转供嵌入排放作为 **scope 2、类别
  `TRANSFER`** 计入，与外购电的 scope 2（类别 `ACTIVITY`）在任何汇总
  行里都分列，不会混；送到绑定设施点上的能量先进入对方池子、不重复
  落账。
- 公司汇总：`POST /accounting/summary` 带 `"view":"company"` 时同时给出
  `grossTotal`（各厂合计，含转供 scope 2）、`elimination`（内部转供
  抵消额，逐气体并逐气体×GWP 抵消 CO2e）、`netTotal`（gross − elimination，
  同一份燃料燃烧只算一次）。只改转供量、不动燃料和外购电时，net 逐位
  不变，厂区间此消彼长（有测试）。

**校验（指到具体字段；导入逐条回报 + 口径装载时月平衡校验）**

| 场景 | code | 字段位置示例 |
|---|---|---|
| 转供总量超过当月该载体产出（含产出被更正调低后） | `TRANSFER_EXCEEDS_OUTPUT` | `transfers` |
| 转供给设施自己 | `TRANSFER_TO_SELF` | `transfers[i].toPointCode` |
| 目标厂区/用能点不存在 | `TRANSFER_TARGET_NOT_FOUND` / `NOT_FOUND` | `transfers[i].toPointCode` |
| 产出/转供单位换不到 GJ | `ENERGY_UNIT_NOT_CONVERTIBLE` | `outputs[i].unit` |
| 某月有转供却无对应产出（或无该载体产出） | `TRANSFER_WITHOUT_OUTPUT` / `CARRIER_MISMATCH` | `transfers[i].month/carrier` |
| 全闭环无最终用能 | 422 `CLOSED_LOOP_NO_FINAL_USE`（点名设施+月份） | — |

单条记录本身合法（数量、单位、目标都对）但**月平衡**被破坏（超供、
更正后变超供、无产出）时，记录照常入库可被更正，核算该月时显式报错，
不会悄悄给出一个数。

**关账、追溯、反向影响**

- 快照行与快照血缘增加 `category`（ACTIVITY/TRANSFER）；TRANSFER 血缘行
  按上游每条一次活动记录记录精确的端到端分摊比例（num/den）、载体和
  路径，因子引用在活动血缘行上。旧快照迁移时只加标签、不重算不改写。
- 关账后东厂补报/更正燃料或转供，西厂已关快照纹丝不动（cut + REPEATABLE
  READ 语义不变，有测试）。
- 正向追溯 `POST /transfer-lineage/trace`：从西厂一个转供 scope 2 数字
  一路到东厂原始燃料记录和因子，每跳带分摊比例，遇环用闭式系数不展开。
- 反向影响 `GET /transfer-lineage/impact/:recordNo`：某记录被更正后，
  哪些**已关账**快照按最新数据重算会变，含只经由转供间接受影响的厂区
  （`viaTransfer: true` 与传播路径）及逐指标精确差额；只做 advisory
  查询，不改任何快照。
- 重述两口径对比/Shapley 分解天然覆盖转供：转供数字是口径的函数，
  只换因子版本时西厂变化全部落在因子项、只更正东厂燃料时全部落在
  活动数据项（有测试）。

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
| 转供超产出（含更正后超供）、无产出转供、载体不符 | 400 | `TRANSFER_EXCEEDS_OUTPUT` / `TRANSFER_WITHOUT_OUTPUT` / `CARRIER_MISMATCH` | `transfers[i].*` |
| 转供给自己 / 目标点不存在 / 能量单位不可换算 | 400 | `TRANSFER_TO_SELF` / `TRANSFER_TARGET_NOT_FOUND` / `ENERGY_UNIT_NOT_CONVERTIBLE` | `transfers[i].toPointCode`、`outputs[i].unit` |
| 全闭环无最终用能 | **422** | `CLOSED_LOOP_NO_FINAL_USE`（body 带 `facilities[]`、`month`） | 网络结构 |

批量导入逐条回报 `{ recordNo, status: accepted|duplicate|rejected, errors[] }`，
非法记录不影响其余记录（整批在一个事务里，但拒绝的行不插入；接受的行一起
提交）。

---

## 5. HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `POST /master-data/sites`、`POST /master-data/sources` | 厂区 / 排放源主数据（upsert，来源可带 `facilityCode`） |
| `POST /master-data/facilities` | 产能设施（upsert） |
| `POST /master-data/delivery-points` | 用能点（upsert；`facilityCode` 可空=最终用能，非空=绑定设施） |
| `POST /factor-versions` | 发布因子库版本（燃料物性 + 三气体因子 + 适用期 + 可选 CHP 参考效率） |
| `GET /factor-versions` | 版本列表 |
| `POST /gwp-sets`、`GET /gwp-sets` | 发布 / 列出 GWP 集合（AR5、AR6…） |
| `POST /activity-records/import` | 批量导入（逐条回报；可带 `validateAgainstFactorVersion`） |
| `POST /activity-records/correct` | 更正一条（并发落败返回 409） |
| `GET /activity-records/:recordNo` | 查单条记录 |
| `POST /activity-records/cuts` | 创建截止点（不传 `asOf` 即“当前已提交的全部”） |
| `GET /activity-records/cuts/:id` | 查截止点 |
| `POST /energy/outputs/import` | 设施月度能量产出批量导入（同活动数据规矩） |
| `POST /energy/transfers/import` | 内部转供批量导入（同活动数据规矩） |
| `POST /accounting/summary` | 按口径汇总；`groupBy` 任取 `site/source/month`，带 filter；`view:"company"` 返回 gross/elimination/net |
| `POST /restatements/compare` | 两口径对比 + Shapley 分解；可带 `baseYear`/阈值 |
| `GET /restatements/base-year-flags/:year` | 基准年标记 |
| `GET /restatements/notes?baseYear=` | 重述说明记录 |
| `POST /closes` | 月度关账，生成披露快照（活动行+转供行、两类血缘） |
| `GET /closes/:id` | 关账元数据（锁定的 cut/因子/GWP） |
| `GET /closes/:id/snapshot` | 快照数字（可按 `category=ACTIVITY|TRANSFER` 过滤） |
| `GET /closes/:id/lineage` | 快照逐行血缘（同上；转供行带上游记录与分摊路径） |
| `POST /lineage/explain` | 活动数据汇总数字由哪些记录、哪些因子得出 |
| `POST /transfer-lineage/trace` | 转供 scope 2 数字 → 上游原始燃料记录/因子的正向追溯 |
| `GET /transfer-lineage/impact/:recordNo` | 记录更正后哪些已关快照按最新数据会变（含转供间接受影响厂区） |

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

## 6. 测试（Jest，53 个用例，7 个文件）

- `fraction.spec.ts`：5.61 t 算例、精确解析、严格相等；
- `units.spec.ts`：SI 换算精确、密度+热值跨量纲**往返不变**、缺物性时报错；
- `accounting.spec.ts`：5.61 t；**厂区合计=各排放源之和、年合计=各月之和**；
  同一口径重复计算逐位相同；追溯解释；
- `transfers.spec.ts`：**14.025 t 手算例**；设施投入排放=各产出分摊之和
  逐位相等；**只改转供量公司 net 逐位不变、厂区此消彼长**；**东西两厂
  成环可解且守恒**；**全闭环无最终用能报错点名设施**；**只换 GWP 集合
  转供链路气体质量不变**；CHP 参考效率分摊（16.5/39.6）及 η 随版本发布
  归入因子项；超供/自转/目标不存在/单位不可换算/无产出/更正后超供等
  字段级校验；**只换因子版本、只更正上游燃料时西厂差额的归因**；
  正向追溯与反向影响（含经转供间接受影响的厂区）；**关账后上游更正
  不动下游快照**及转供血缘；cut 不可见晚到转供；**无转供数据时与旧
  结果逐位一致**；重复提交幂等；
- `restatement.spec.ts`：**三部分之和严格等于总差额**（四个指标）；
  Shapley 交互项对半；**只换 GWP 时 CO2/CH4/N2O 不变**；6% 变化触发基准年
  标记并生成说明；未超阈值不标记；
- `close.spec.ts`：关账后发布新因子、提交更正、补录均**不影响快照**；
  快照与按关账口径全量重算一致；快照血缘；重复关账被拒；
- `activity-data.spec.ts`：逐条校验（负/非有限数、单位不可换算、月份超期、
  更正目标缺失/已更正、因子期重叠）；**并发更正只接受一个**；
  **重复提交幂等不重复计数**；更正链在 cut 处取链头。

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
- `snapshot_rows` 主键为 `(close_id, site, source, month, scope, gas,
  category)`，含 `CO2/CH4/N2O/CO2E` 行，`category` 区分活动行（ACTIVITY）
  与转供范围二行（TRANSFER）；`snapshot_lineage` 按
  `(close_id, record_no, gas, category, upstream_record_no)` 记录：
  活动行带因子 id、换算后的活动量、气体质量；转供行带载体、上游一次
  活动记录号与每跳精确分摊比例（JSON，num/den）；
- 内部转供表 `facilities` / `delivery_points` / `energy_outputs` /
  `energy_transfers` 均沿用活动数据的编号、更正链（部分唯一索引）与
  cut 可见性设计；`chp_reference_efficiencies` 挂在因子版本下；
- 0002 迁移是**加性**的：旧快照/血缘行只取默认标签 `ACTIVITY`、上游号
  取哨兵值 `''`，数字一律不重算不改写；`snapshot_lineage.record_no` 的
  硬外键改为按 `category` 由应用解析（该列现在多态：转供行指向
  `energy_transfers` 记录），`factor_id` 对转供行允许为空；
- 所有 id 用 `integer GENERATED ALWAYS AS IDENTITY`；计量值分子分母用 `bigint`。
