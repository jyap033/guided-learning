# Chapter 1: Hardware Basics · Data & Formats

*Part: Foundations · 10 concepts · [curriculum](../curriculum.md#chapter-1)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo manages physical servers. To follow what it does, you need two kinds of background. The first is the **data formats** used for configuration, APIs and storage. The second is the **hardware vocabulary** that shows up in its APIs and discovery data. This chapter covers both. It's the first chapter, so it assumes only basic programming and comfort with a terminal.

The first four lessons cover formats you'll read and write constantly:

- **TOML** is the usual configuration format in the Rust ecosystem, and NICo Core is written in Rust. You'll also use TOML in this chapter's build task.
- **Protocol Buffers** define NICo's Core APIs.
- **Relational databases** hold NICo's state in tables. NICo REST's deployment manages a PostgreSQL schema through migrations.
- **YAML** is the language of the Helm charts that deploy NICo.

The last six lessons cover hardware: MAC addresses, PCIe devices, NUMA nodes, CPU architectures, how a server is built, and PCI addresses like `0000:ca:00.0`. These terms appear directly in how NICo uses Redfish and in its discovery data. Three examples:

- NICo pairs DPUs with hosts using PCIe serial numbers.
- It looks up BMC credentials by MAC address.
- It turns a tenant's choice of InfiniBand device into one exact piece of hardware by sorting PCI addresses.

Every lesson runs on a laptop. The chapter ends with a build task, a small "site-inventory resolver". It reads a TOML site file and YAML discovery data, cleans up messy MAC addresses, loads everything into SQLite and selects devices by PCI address. It's a small version of work NICo does at datacenter scale.

**By the end of this chapter you can:**

- Read and write TOML, YAML and Protocol Buffers schemas, and predict what type a parser gives each value, including YAML's surprise conversions
- Model inventory data as related SQL tables and query it with JOIN, GROUP BY and LEFT JOIN … IS NULL
- Normalize MAC addresses from different sources (Redfish fields, UEFI device paths, config files) into one form that can be compared
- Find PCIe devices, their vendor and device IDs and their NUMA nodes on a Linux machine, and explain how Redfish PCIe serial numbers drive DPU-host pairing
- Decode a PCI address such as 0000:ca:00.0 and use it to map a (device, fabric, device_instance) selection to the same hardware every time
- Explain why a binary built for amd64 won't run natively on arm64, and what that means for x86 hosts and Arm-based DPUs

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [TOML](#toml)
2. [Protocol Buffers](#protocol-buffers)
3. [Relational databases and SQL](#relational-databases-and-sql)
4. [YAML](#yaml)
5. [MAC address](#mac-address)
6. [PCIe device](#pcie-device)
7. [NUMA node](#numa-node)
8. [CPU architectures (amd64 vs arm64)](#cpu-architectures)
9. [Server hardware basics](#server-hardware-basics)
10. [PCI device and slot address](#pci-device-and-slot-address)
11. [Build task: Site-inventory resolver](#build-task)

<a id="toml"></a>
## 1. TOML

### Before you read

- In a config file, how would you write a list of three racks, each with a name and a row, without making `racks` an ordinary key whose value is a long list?
- Guess: in TOML, is `enabled = yes` valid?

<details>
<summary>Answers</summary>

- **In a config file, how would you write a list of three racks, each with a name and a row, without making `racks` an ordinary key whose value is a long list?** TOML has 'arrays of tables'. Each `[[racks]]` header starts a new element of the `racks` array, and the key-value lines under it belong to that element. You repeat the header, and every repeat adds to the same list.
- **Guess: in TOML, is `enabled = yes` valid?** No. TOML booleans are only `true` and `false` (lowercase), and every string has to be quoted. A bare `yes` is a parse error. That strictness is one of TOML's main advantages over YAML.

</details>

### Explanation

**TOML** (Tom's Obvious, Minimal Language) is a configuration format that's easy to read and maps to exactly one data structure, so there's nothing ambiguous about it. It's the standard config format of the Rust ecosystem: every Rust project has a `Cargo.toml`. NICo Core is NICo's Rust control plane, and NICo's docs mention that features are switched on and off through NICo config files. You'll meet NICo's site configuration in a later chapter, and the NICo docs will tell you the format of each file there. This lesson teaches TOML itself, and you'll use it in this chapter's build task.

The building blocks:

- **Key-value pairs**: `site_name = "lab-west"`. The key goes on the left and a typed value on the right.
- **Value types**: strings (always quoted, `"..."` or `'...'`), integers (`42`), floats (`1.5`), booleans (`true`/`false` only), dates and times (`2026-11-20T10:00:00Z`), arrays (`["a", "b"]`) and inline tables (`{ name = "R01", row = "A" }`).
- **Tables**: a header like `[dhcp]` starts a named group. Every key below it, up to the next header, belongs to that table. `[site.dhcp]` creates a table nested inside `site`. A **dotted key** such as `dhcp.enabled = true` does the same thing on one line.
- **Arrays of tables**: `[[racks]]` appends a new table to an array called `racks`. You repeat the header once for each element.
- **Comments** start with `#`.

Keys at the top of the file, before any header, belong to the root table. After a `[table]` header, every following key goes into that table, so root-level keys have to come first. Defining the same table twice, or the same key twice, is an error. The parser rejects the file and doesn't guess which one you meant.

TOML's value is its strictness. Strings must be quoted, so a MAC address, a version like `"1.10"` or a country code `"no"` can't turn into a number or a boolean by accident. The YAML lesson shows why that matters.

In Python 3.11+, the standard library reads TOML with `tomllib`. It can only read, and you must open the file in binary mode (`"rb"`). To write TOML you need a third-party package such as `tomli-w`.

**Analogy.** TOML is like a paper form with labelled boxes and section headings. Each heading is a section, each box is a key, and you fill in a value of the right kind. A `[[racks]]` heading is a stack of identical blank pages, and you fill in one page per rack. The analogy breaks down because a person reading a paper form will accept a scribbled answer. A TOML parser rejects the whole file if a single value has the wrong shape, such as an unquoted string.

### Worked example: Write a small site file and see what the parser builds

**Step 1: Write the file.**

Create `site.toml`:

```toml
# Root keys come first
site_name = "lab-west"

[dhcp]
enabled = true
subnets = ["10.0.1.0/24", "10.0.2.0/24"]

[[racks]]
name = "R01"
row = "A"

[[racks]]
name = "R02"
row = "A"
```

**Step 2: Parse it into JSON to see the structure.**

Needs Python 3.11+ (`python3 --version`).

```sh
python3 -c 'import tomllib, json; print(json.dumps(tomllib.load(open("site.toml", "rb")), indent=2))'
```

Output:

```json
{
  "site_name": "lab-west",
  "dhcp": {
    "enabled": true,
    "subnets": ["10.0.1.0/24", "10.0.2.0/24"]
  },
  "racks": [
    {"name": "R01", "row": "A"},
    {"name": "R02", "row": "A"}
  ]
}
```
(Python's real output puts each list item on its own line.)

**Step 3: Map headers to structure.**

`[dhcp]` became a nested object. The two `[[racks]]` headers became a two-element array. `true` is a real boolean, and the subnets are strings.

**Step 4: Break it on purpose.**

Add `enabled = yes` under `[dhcp]` and run the command again. You get a `tomllib.TOMLDecodeError` that points at the line. Change it back. Then add a second `[dhcp]` header at the end of the file. That also fails, because a table can't be defined twice.

### Your turn: finish it

Fill in the blank so that `racks` parses as an array of two tables, R01 and R02.

```text
site_name = "lab-west"

[[racks]]
name = "R01"
row = "A"

___
name = "R02"
row = "B"
```

<details>
<summary>Answer</summary>

`[[racks]]`. Each array-of-tables header starts a new element. If you write `[racks]` instead, the parser raises an error, because `racks` is already an array and can't be redefined as a plain table.

</details>

### Your turn: on your own

Write TOML that parses to exactly this Python dict:

```python
{"site": {"name": "lab", "dhcp": {"enabled": True, "subnets": ["10.0.1.0/24", "10.0.2.0/24"]}}}
```
Check it with the `tomllib` one-liner from the worked example.

<details>
<summary>Hint 1</summary>

There are no root-level keys. Everything lives under `site`.

</details>

<details>
<summary>Hint 2</summary>

`dhcp` is a table inside `site`. TOML writes that as a dotted table header.

</details>

<details>
<summary>Hint 3</summary>

Write `[site]` with `name = "lab"`, then `[site.dhcp]` with `enabled = true` and a `subnets` array of two quoted strings.

</details>

<details>
<summary>Answer</summary>

```toml
[site]
name = "lab"

[site.dhcp]
enabled = true
subnets = ["10.0.1.0/24", "10.0.2.0/24"]
```
A version with a single table also works: `[site]`, `name = "lab"`, `dhcp.enabled = true`, `dhcp.subnets = [...]`.

</details>

### Explain it

In your own words: TOML refuses to guess: duplicate tables are errors and strings must be quoted. Why does that make a large site config safer to operate than a more forgiving format would?

### Check

**1. What does `[[expected_machines]]` do in TOML?**

A. Appends a new table to an array named expected_machines
B. Declares a nested table named expected_machines inside the previous table
C. Starts a comment block
D. Defines expected_machines as a table that can be redefined later

<details>
<summary>Answer</summary>

**A.** Appends a new table to an array named expected_machines

Double brackets mean an array of tables, so each occurrence adds one element. Single brackets `[x]` declare a table, and a dotted header like `[a.b]` is what nests one table inside another. Redefining a table is an error, not a feature.

</details>

**2. Which line gives you the string "1.10" rather than a number?**

A. version = "1.10"
B. version = 1.10
C. version = '1.10'f
D. version: 1.10

<details>
<summary>Answer</summary>

**A.** version = "1.10"

Only a quoted value is a string. `1.10` is the float 1.1, so the trailing zero is lost. `'1.10'f` isn't valid TOML. `version: 1.10` uses YAML's colon syntax, which TOML rejects.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

<a id="protocol-buffers"></a>
## 2. Protocol Buffers

### Before you read

- A Rust program and a Go program need to exchange a message describing an InfiniBand device. What do they have to agree on before either one sends a byte?
- Guess: if you rename a field in a protobuf message but keep its number, can old programs still read new messages?

<details>
<summary>Answers</summary>

- **A Rust program and a Go program need to exchange a message describing an InfiniBand device. What do they have to agree on before either one sends a byte?** A shared schema: which fields exist, what types they have, and how they're encoded on the wire. Protocol Buffers keeps that schema in a `.proto` file and generates matching code for each language.
- **Guess: if you rename a field in a protobuf message but keep its number, can old programs still read new messages?** Yes, in the binary format. Only the field number and type go on the wire, not the name. A rename still changes the JSON form and the generated code, so it isn't completely free.

</details>

### Explanation

**Protocol Buffers** (protobuf) is a schema language and a compact binary serialization format created by Google. You describe your data in a `.proto` file. A compiler, `protoc`, then generates classes for Rust, Go, Python and other languages that build, serialize and parse those messages.

NICo uses protobuf as the interface definition for its Core APIs. The proto definitions originate in NICo Core and are synchronized to NICo REST. The Site Agent talks to Core over gRPC, an RPC framework that carries protobuf messages, and Temporal workflows in NICo REST carry protobuf-encoded payloads. Here is a real message from NICo's discovery data model:

```protobuf
message InfinibandInterface {
  PciDeviceProperties pci_properties = 1;
  string guid = 2;
}

message PciDeviceProperties{
  string vendor = 1;
  string device = 2;
  string path = 3;
  sint32 numa_node = 4;
  optional string description = 5;
}
```

Key terms:

- **message**: a record type with named, typed fields. A field's type can be another message, as with `pci_properties`.
- **field number** (`= 1`, `= 2`): the identifier that's actually written to the wire. Names exist for humans and for generated code. Once a number is in use, never change it and never reuse it for something else.
- **scalar types**: `string`, `bool`, `int32`, `uint64` and so on. `sint32` is an integer type with "zigzag" encoding, which stores negative values efficiently. That suits a NUMA node, which can be `-1` when unknown.
- **repeated**: the field is a list.
- **optional**: in proto3, this lets you tell "not set" apart from "set to the default" (an empty string, or 0).

Only numbers go on the wire, so NICo's design notes can propose renaming `InfinibandInterface` to `InfinibandDevice` without breaking the binary format. JSON output uses field names, though, so a rename does change that.

**Analogy.** A `.proto` file is like a numbered shipping manifest that the sender and receiver both hold. The box only says "item 1: …, item 2: …", and each side looks up what item 2 means in its own copy. The analogy breaks down because a protobuf receiver silently ignores numbers it doesn't recognise, and that's how old and new versions coexist. Most people checking a real manifest would query an unknown line.

### Worked example: Compile NICo's InfinibandInterface schema and round-trip a message

**Step 1: Install the compiler as a Python package.**

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install grpcio-tools protobuf
```
`grpcio-tools` bundles `protoc`, so you don't need a system install.

**Step 2: Write the schema.**

Save this as `ib.proto`. It's the message from the docs plus the required header line:

```protobuf
syntax = "proto3";

message InfinibandInterface {
  PciDeviceProperties pci_properties = 1;
  string guid = 2;
}

message PciDeviceProperties {
  string vendor = 1;
  string device = 2;
  string path = 3;
  sint32 numa_node = 4;
  optional string description = 5;
}
```

**Step 3: Generate Python code.**

```sh
python -m grpc_tools.protoc -I. --python_out=. ib.proto
ls ib_pb2.py
```

**Step 4: Build, serialize and parse a message.**

Save this as `roundtrip.py` and run `python roundtrip.py`:

```python
import ib_pb2
from google.protobuf.json_format import MessageToJson

d = ib_pb2.InfinibandInterface(guid="1234")
d.pci_properties.vendor = "0x15b3"
d.pci_properties.device = "0x101b"
d.pci_properties.numa_node = 1

data = d.SerializeToString()
print(len(data), data.hex())
print(MessageToJson(ib_pb2.InfinibandInterface.FromString(data)))
```
You should see 26 bytes: `0a120a0630783135623312063078313031622002120431323334`.

**Step 5: Read the bytes.**

`0a` means field 1, length-delimited (the nested message), and `12` means it's 18 bytes long. Inside it, `0a 06 …` is vendor (field 1, 6 bytes), `12 06 …` is device (field 2), and `20 02` is numa_node (field 4). The value 1 is stored as 2 because of zigzag encoding. Finally, `12 04 31323334` is guid "1234". No field names appear anywhere. The JSON output uses lowerCamelCase names (`pciProperties`, `numaNode`) and leaves out unset fields such as `path`.

### Your turn: finish it

NICo's design notes suggest storing a PCI `slot` and a `fabric` identifier. Add both fields without breaking compatibility with existing messages. Fill in the two field numbers.

```text
syntax = "proto3";

message InfinibandInterface {
  PciDeviceProperties pci_properties = 1;
  string guid = 2;
  string fabric = ___;
}

message PciDeviceProperties {
  string vendor = 1;
  string device = 2;
  string path = 3;
  sint32 numa_node = 4;
  optional string description = 5;
  string slot = ___;
}
```

<details>
<summary>Answer</summary>

`fabric = 3` and `slot = 6`. Use the next unused number in each message. Field numbers belong to their own message, so `3` in InfinibandInterface doesn't clash with `path = 3` in PciDeviceProperties. Reusing an existing number, such as `slot = 3`, would make old readers read the slot bytes as `path`.

</details>

### Your turn: on your own

Write a proto3 `.proto` file for a host's Ethernet interface report. Base it on the Redfish fields NICo reads: an interface `id`, a `mac_address`, a `uefi_device_path`, and an `interface_enabled` flag where "not reported" must be distinguishable from `false`. Then write a `HostInterfaces` message that holds a host `serial_number` and a list of interfaces. Compile it with `grpc_tools.protoc` to check it.

<details>
<summary>Hint 1</summary>

You need two messages, and the second one contains the first.

</details>

<details>
<summary>Hint 2</summary>

A list is a `repeated` field. To tell "unset" apart from `false` on a bool, use the `optional` keyword.

</details>

<details>
<summary>Hint 3</summary>

Number the fields from 1 in each message: `optional bool interface_enabled = 4;` and `repeated EthernetInterface interfaces = 2;`.

</details>

<details>
<summary>Answer</summary>

```protobuf
syntax = "proto3";

message EthernetInterface {
  string id = 1;
  string mac_address = 2;
  string uefi_device_path = 3;
  optional bool interface_enabled = 4;
}

message HostInterfaces {
  string serial_number = 1;
  repeated EthernetInterface interfaces = 2;
}
```

</details>

### Explain it

In your own words: Why does protobuf put field numbers on the wire instead of field names, and what rule does that impose when you change a schema that's already deployed?

### Check

**1. A teammate changes `string path = 3;` to `string path = 7;` in a deployed schema. What happens when an old reader receives a new message?**

A. The old reader doesn't see `path`; it ignores field 7 as unknown
B. Nothing changes, because the field is still called path
C. The old reader crashes because the names don't match
D. The old reader reads field 7 into description

<details>
<summary>Answer</summary>

**A.** The old reader doesn't see `path`; it ignores field 7 as unknown

Readers match fields by number. The old reader expects path at 3, finds nothing there, and skips the unknown field 7. Names never go over the wire, so "still called path" doesn't help, and protobuf readers don't crash on unknown fields.

</details>

**2. Why might `numa_node` be declared `sint32` rather than `uint32`?**

A. It can be negative (e.g. -1 for unknown), and sint32 encodes negative numbers compactly
B. sint32 is the only integer type protobuf supports
C. sint32 values are stored as strings
D. uint32 can't hold the value 1

<details>
<summary>Answer</summary>

**A.** It can be negative (e.g. -1 for unknown), and sint32 encodes negative numbers compactly

Linux reports -1 for devices with no known NUMA node, and uint32 can't represent that. A plain int32 encodes -1 in 10 bytes, while zigzag sint32 needs only 1. Protobuf has many integer types, and none of them are stored as strings.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="relational-databases-and-sql"></a>
## 3. Relational databases and SQL

### Before you read

- You have machines, and each machine has several network interfaces. Would you store the interfaces inside each machine record, or in a separate list? Why?
- Guess what this returns: `SELECT serial FROM machine WHERE state = 'Ready' ORDER BY serial;`

<details>
<summary>Answers</summary>

- **You have machines, and each machine has several network interfaces. Would you store the interfaces inside each machine record, or in a separate list? Why?** In a separate table, where each interface row points to its machine with a foreign key. Then you can search interfaces directly (by MAC, for example), add more without changing the machine rows, and let the database enforce that every interface belongs to a real machine.
- **Guess what this returns: `SELECT serial FROM machine WHERE state = 'Ready' ORDER BY serial;`** The serial numbers of all machines whose state is 'Ready', in alphabetical order.

</details>

### Explanation

A **relational database** stores data in **tables**. A table has named, typed **columns**, and each **row** is one record. You read and change data with **SQL** (Structured Query Language). You describe *what* you want, and the database works out *how* to get it.

Core ideas:

- **Primary key**: a column, or set of columns, that uniquely identifies a row, such as a machine ID.
- **Foreign key**: a column that refers to another table's primary key. For example, `interface.machine_id` points at `machine.id`. These links between tables are what "relational" refers to.
- **Constraints**: `NOT NULL`, `UNIQUE` and foreign keys make the database reject bad data, such as two machines with the same BMC MAC.
- **CRUD**: create, read, update and delete, done with `INSERT`, `SELECT`, `UPDATE` and `DELETE`.
- **JOIN**: combines rows from two tables wherever a condition matches. `INNER JOIN` keeps only matching rows. `LEFT JOIN` keeps every row from the left table and fills in `NULL` where nothing matches. That's how you find things that are *missing*.
- **GROUP BY** with `COUNT`, `SUM` and similar functions collapses rows into summaries.
- **Transactions**: a group of changes that either all happen or none do.

NICo keeps its state in database tables. For example, during machine ingestion it stores network-interface data collected in-band and out-of-band in its `machine` and `machine_topologies` tables. The networking integrations record the *actual* network state on the Machine object. Other workflows read that stored state instead of asking external services, and that single shared source of truth keeps decisions deterministic. NICo REST's deployment includes a database migrations component that manages the PostgreSQL schema as it changes over time. PostgreSQL gets its own chapter later in the course.

For practice you'll use **SQLite**, a full SQL database stored in a single file. It comes with Python (`import sqlite3`) and with macOS (the `sqlite3` CLI). On Debian or Ubuntu, run `sudo apt install sqlite3`. One SQLite quirk: it only enforces foreign keys after you run `PRAGMA foreign_keys = ON;`.

**Analogy.** Tables are like the sheets of one spreadsheet workbook, with a rule that a column in one sheet may only contain IDs that exist in another sheet. A JOIN is a VLOOKUP that the database runs for you. The analogy breaks down because a spreadsheet happily accepts a mistyped ID or a duplicate. A database with constraints refuses the write, and it stays consistent even when many programs write at the same time.

### Worked example: Model machines and their interfaces, then join them

**Step 1: Create the schema.**

Run `sqlite3 inv.db` and paste:

```sql
PRAGMA foreign_keys = ON;
CREATE TABLE machine (
  id     TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  state  TEXT NOT NULL
);
CREATE TABLE interface (
  mac        TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machine(id),
  is_bmc     INTEGER NOT NULL DEFAULT 0
);
```

**Step 2: Insert rows.**

```sql
INSERT INTO machine VALUES
  ('h1', 'J1234XY', 'Ready'),
  ('h2', 'K5678ZW', 'Assigned'),
  ('h3', 'M9012QR', 'Ready');
INSERT INTO interface VALUES
  ('B8:3F:D2:90:95:82', 'h1', 1),
  ('B8:3F:D2:90:95:83', 'h1', 0),
  ('B8:3F:D2:90:95:9A', 'h2', 1);
```

**Step 3: Watch a constraint protect you.**

```sql
INSERT INTO interface VALUES ('AA:BB:CC:00:11:22', 'h9', 0);
```
You get `FOREIGN KEY constraint failed`, because there is no machine h9. Insert `'B8:3F:D2:90:95:82'` a second time and you get `UNIQUE constraint failed`, because a MAC can belong to only one row.

**Step 4: Join to answer a question.**

"Which BMC MAC belongs to each machine?"

```sql
.mode column
SELECT m.serial, m.state, i.mac
FROM machine m
JOIN interface i ON i.machine_id = m.id
WHERE i.is_bmc = 1
ORDER BY m.serial;
```
Output: `J1234XY Ready B8:3F:D2:90:95:82` and `K5678ZW Assigned B8:3F:D2:90:95:9A`. M9012QR is missing because an inner join drops rows that have no match.

### Your turn: finish it

Using the same tables, list every machine with its number of interfaces, including machines that have none. Fill in the blank.

```text
SELECT m.serial, COUNT(i.mac) AS n
FROM machine m
LEFT JOIN interface i ON i.machine_id = m.id
___ m.serial
ORDER BY m.serial;
```

<details>
<summary>Answer</summary>

`GROUP BY`. The result is J1234XY 2, K5678ZW 1, M9012QR 0. `LEFT JOIN` keeps M9012QR, and `COUNT(i.mac)` counts only non-NULL values, so that row gets 0 instead of 1.

</details>

### Your turn: on your own

Write a query that returns the serial of every machine that has **no BMC interface**. With the sample data, the answer should be only M9012QR.

<details>
<summary>Hint 1</summary>

To find something that's missing, use a LEFT JOIN plus a NULL check.

</details>

<details>
<summary>Hint 2</summary>

Put the `is_bmc = 1` condition in the `ON` clause, not in `WHERE`. In `WHERE` it would throw away the NULL rows you're looking for.

</details>

<details>
<summary>Hint 3</summary>

`LEFT JOIN interface i ON i.machine_id = m.id AND i.is_bmc = 1 WHERE i.mac IS NULL`

</details>

<details>
<summary>Answer</summary>

```sql
SELECT m.serial
FROM machine m
LEFT JOIN interface i
  ON i.machine_id = m.id AND i.is_bmc = 1
WHERE i.mac IS NULL;
```
This returns `M9012QR`.

</details>

### Explain it

In your own words: NICo records the observed network state in its own database, and its other workflows read that copy instead of querying the network devices. Why does deciding from one stored copy make the system more predictable?

### Check

**1. You want every expected machine listed, together with its discovered BMC if there is one. Which join do you use?**

A. expected LEFT JOIN discovered
B. expected INNER JOIN discovered
C. discovered INNER JOIN expected
D. expected CROSS JOIN discovered

<details>
<summary>Answer</summary>

**A.** expected LEFT JOIN discovered

LEFT JOIN keeps every row from the left table (expected) and fills in NULLs where nothing was discovered. Either INNER JOIN drops the undiscovered machines, which are exactly the ones you need to see. CROSS JOIN pairs every row with every other row.

</details>

**2. What does a UNIQUE constraint on `bmc_mac` give you?**

A. The database rejects a second row with the same BMC MAC
B. MACs are automatically normalized to uppercase
C. Queries on bmc_mac return rows in sorted order
D. Rows without a MAC are rejected

<details>
<summary>Answer</summary>

**A.** The database rejects a second row with the same BMC MAC

UNIQUE prevents duplicates. It doesn't normalize anything: 'b8:3f…' and 'B8:3F…' are different strings to the database. Sorted output needs ORDER BY, and rejecting missing values is the job of NOT NULL.

</details>

**Sources:** [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="yaml"></a>
## 4. YAML

### Before you read

- In YAML, what do you think `country: no` loads as in Python's PyYAML?
- Guess what PyYAML does with `bmc_mac: 50:00:12:34:56:01`.

<details>
<summary>Answers</summary>

- **In YAML, what do you think `country: no` loads as in Python's PyYAML?** The boolean `False`. PyYAML follows YAML 1.1, where yes/no/on/off are booleans. This is the well-known "Norway problem". Quote the value: `country: "no"`.
- **Guess what PyYAML does with `bmc_mac: 50:00:12:34:56:01`.** It loads it as the integer 38882717761, because YAML 1.1 reads colon-separated groups of digits as base-60 (sexagesimal) numbers. A MAC that contains hex letters, like b8:3f:…, stays a string. Always quote MACs.

</details>

### Explanation

**YAML** ("YAML Ain't Markup Language") is a human-friendly data format that uses **indentation** to show structure. Kubernetes manifests, Helm charts and values files are all YAML, and both NICo Core and NICo REST are deployed into Kubernetes with Helm charts. You'll edit a lot of it.

The pieces:

- **Mapping** (a dictionary): `key: value`. The space after the colon is required.
- **Sequence** (a list): one item per line, each starting with `- `. Under a key, the items can be indented (`racks:` followed by `  - name: R01`) or start at the same column as the key (`racks:` followed by `- name: R01`). Both forms are valid. Pick one style and stick to it within a file.
- **Nesting** is shown by indentation with **spaces only**. A tab is a syntax error. Keys in the same mapping have to line up at exactly the same column.
- **Scalars** (single values) can be plain (`lab-west`), single-quoted (`'x'`) or double-quoted (`"x"`, which supports escapes such as `\n`). For multi-line text, `|` keeps the newlines and `>` folds the lines together.
- **Flow style** is JSON-like: `[a, b]` and `{k: v}`. Most JSON is valid YAML.
- `#` starts a comment, and `---` separates several documents in one file. Kubernetes uses this a lot.

The big trap is **implicit typing**. YAML guesses whether an unquoted scalar is a number, a boolean, null or a string. PyYAML, the usual Python library, implements YAML 1.1, so:

- `yes`, `no`, `on`, `off` become booleans
- `1.10` becomes the float `1.1`, and the version number is lost
- `50:00:12:34:56:01` becomes a base-60 integer
- `~` or `null` becomes None

YAML 1.2 parsers drop some of these rules, but you rarely know which parser will read your file. So quote anything that must stay a string: MACs, versions, IDs and PCI addresses. That's the most important habit for infrastructure YAML. Load untrusted YAML with `yaml.safe_load`. Plain `yaml.load` with an unsafe loader can construct arbitrary Python objects.

**Analogy.** YAML is like an outline in a notebook, where indented items belong to the line above them. The analogy breaks down twice. A stray space in a notebook outline is harmless, but in YAML it can move a key to a different parent. And no notebook quietly turns the word "no" into "false".

### Worked example: See how PyYAML types what you wrote

**Step 1: Get PyYAML.**

Run `pip install pyyaml` in a venv, or do everything in Docker: `docker run --rm -it python:3.12-slim sh -c "pip install -q pyyaml && python"`.

**Step 2: Load a file with traps in it.**

```sh
python3 -c 'import yaml, sys; print(yaml.safe_load(sys.stdin))' <<'EOF'
site: lab-west
dhcp_enabled: yes
racks:
  - name: R01
    bmc_macs:
      - b8:3f:d2:90:95:82
      - 50:00:12:34:56:01
version: 1.10
EOF
```

**Step 3: Read the result.**

```python
{'site': 'lab-west', 'dhcp_enabled': True, 'racks': [{'name': 'R01', 'bmc_macs': ['b8:3f:d2:90:95:82', 38882717761]}], 'version': 1.1}
```
There are three surprises: `yes` became True, the all-digit MAC became an integer, and `1.10` became `1.1`. The MAC with hex letters survived only because letters can't form a number.

**Step 4: Fix by quoting.**

Change those lines to `dhcp_enabled: true`, `- "50:00:12:34:56:01"` and `version: "1.10"`, then run it again. Every value now has the type you meant.

**Step 5: See the structure.**

`racks` is a sequence (`- `) of mappings. `name` and `bmc_macs` both start at column 4, so they're keys of the same list item. If you indent `bmc_macs` by two spaces instead, you get a parse error. It would sit at the same column as the `- ` dashes, where only another `- ` item is allowed.

### Your turn: finish it

Fill in the blank so that R01's only BMC MAC loads as the **string** `50:00:12:34:56:01`. The blank stands for exactly the missing characters.

```text
site: lab-west
racks:
  - name: R01
    bmc_macs:
      - ___
  - name: R02
    bmc_macs: []
```

<details>
<summary>Answer</summary>

`"50:00:12:34:56:01"`, including the double quotes. The line becomes `      - "50:00:12:34:56:01"`. Without the quotes, PyYAML produces the integer 38882717761.

</details>

### Your turn: on your own

This file has three problems. Find them and give a corrected version:

```yaml
site: lab-west
country: no
firmware_version: 1.10
racks:
<TAB>- name: R01
```
(`<TAB>` marks a literal tab character.)

<details>
<summary>Hint 1</summary>

One problem stops the file from parsing at all. The other two parse but produce the wrong types.

</details>

<details>
<summary>Hint 2</summary>

YAML indentation must use spaces. Then check what YAML 1.1 does with `no` and with `1.10`.

</details>

<details>
<summary>Hint 3</summary>

Indent with two spaces (or put the `- ` at column 0), quote "no" and quote "1.10".

</details>

<details>
<summary>Answer</summary>

```yaml
site: lab-west
country: "no"
firmware_version: "1.10"
racks:
  - name: R01
```
The tab is a parse error. Unquoted, `no` would load as False and `1.10` as the float 1.1. Writing `- name: R01` at column 0 under `racks:` would also be valid.

</details>

### Explain it

In your own words: Why is "quote anything that must stay a string" a better habit than memorizing which unquoted values a particular YAML parser converts?

### Check

**1. PyYAML loads `slot: 0000:00:01.0` unquoted. What's the safest description of the risk?**

A. It may be converted into a number, so you should quote PCI addresses
B. It always stays a string because it starts with zero
C. It is a syntax error because of the colons
D. It becomes a list of four parts

<details>
<summary>Answer</summary>

**A.** It may be converted into a number, so you should quote PCI addresses

YAML 1.1 has base-60 (sexagesimal) rules for floats and integers. This value matches the base-60 float form, so it doesn't survive as text. A leading zero doesn't protect it. Colons without a following space are legal in plain scalars, and YAML never splits a scalar into a list.

</details>

**2. Which statement about YAML indentation is correct?**

A. Spaces only, with sibling keys aligned at the same column
B. Tabs or spaces, as long as you are consistent
C. Exactly four spaces per level, always
D. Tabs are allowed on lines that start with `- `

<details>
<summary>Answer</summary>

**A.** Spaces only, with sibling keys aligned at the same column

YAML forbids tabs for indentation everywhere, including on sequence lines. You choose the width of each level (2 is common), but siblings have to line up. A sequence under a key may be indented or start at the key's own column. Both are valid.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="mac-address"></a>
## 5. MAC address

### Before you read

- These came from different tools: `B8:3F:D2:90:95:82`, `b8-3f-d2-90-95-82`, `B83FD2909582`. Are they the same interface?
- Why might a system store credentials under a network card's MAC address rather than its IP address?

<details>
<summary>Answers</summary>

- **These came from different tools: `B8:3F:D2:90:95:82`, `b8-3f-d2-90-95-82`, `B83FD2909582`. Are they the same interface?** Yes. A MAC is 48 bits, which is 12 hex digits. Separators and letter case are only presentation. You have to normalize MACs before you can compare them.
- **Why might a system store credentials under a network card's MAC address rather than its IP address?** The IP is handed out by DHCP and can change. The MAC is built into the hardware, so it identifies the device from its very first DHCP request, before anything else is known about it.

</details>

### Explanation

A **MAC address** (Media Access Control address) is the hardware address of a network interface. It's 48 bits long, written as 6 **octets** (bytes) in hex, such as `B8:3F:D2:90:95:82`. Ethernet switches deliver frames by MAC. A DHCP server sees the MAC in every request, before the device has an IP address.

Structure:

- The first three octets are usually the **OUI** (Organizationally Unique Identifier), a block assigned to a manufacturer.
- Two bits in the first octet are flags. If bit 0 (the least significant) is 1, the address is **multicast**. If it's 0, it's unicast. If bit 1 is 1, the address is **locally administered**, meaning software set it, not the factory. Docker containers get addresses starting `02:42`, and `0x02` has bit 1 set.
- Formats vary: `aa:bb:cc:dd:ee:ff` (Linux), `AA-BB-CC-DD-EE-FF` (Windows), `aabb.ccdd.eeff` (Cisco), and bare `AABBCCDDEEFF` inside UEFI device paths.

NICo relies on MACs in several places:

- **BMC discovery**: when a BMC requests an address over DHCP, NICo looks its MAC up in the expected-machines table to find initial credentials. The docs mark the Redfish `MACAddress` field under `Managers/{id}/EthernetInterfaces` as *Critical* for BMC identification and for credential storage and lookup.
- **DPU-host pairing**: `MACAddress` under `Systems/{id}/EthernetInterfaces` is also *Critical*. NICo accepts both the `MACAddress` and `MacAddress` spellings because vendors differ.
- **UEFI boot options**: NICo extracts MACs from device paths such as `.../MAC(B83FD2909582,0x1)` and reformats them as `B8:3F:D2:90:95:82`.
- **Uniqueness**: a switch goes to the `Error` state if its expected config declares a MAC that belongs to another switch.

The practical lesson is to normalize every MAC to one standard form as soon as it enters your system, before you compare or store it.

**Analogy.** A MAC address is like a car's VIN. It's stamped at the factory and identifies the car wherever it's parked, while the IP address is more like the number of the parking space. The analogy breaks down because a MAC can be changed in software, and some are deliberately locally administered. A VIN is meant to be permanent.

### Worked example: Find your MACs, then normalize one from a UEFI device path

**Step 1: List your own interfaces.**

Linux: `ip -br link` (the third column is the MAC). macOS: `ifconfig en0 | grep ether`. Loopback shows `00:00:00:00:00:00` because it has no hardware.

**Step 2: Extract a MAC from a Redfish boot option.**

The sample `UefiDevicePath` from Redfish is `PciRoot(0x2)/Pci(0x1,0x0)/Pci(0x0,0x0)/MAC(B83FD2909582,0x1)`.

```python
import re
path = "PciRoot(0x2)/Pci(0x1,0x0)/Pci(0x0,0x0)/MAC(B83FD2909582,0x1)"
raw = re.search(r"MAC\(([0-9A-Fa-f]{12}),", path).group(1)
print(":".join(raw[i:i+2] for i in range(0, 12, 2)))
```
Output: `B8:3F:D2:90:95:82`.

**Step 3: Normalize any format.**

```python
import re
def normalize(mac):
    digits = re.sub(r"[:\-.]", "", mac)
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", digits):
        raise ValueError(mac)
    return ":".join(digits[i:i+2] for i in range(0, 12, 2)).upper()

for m in ["b8-3f-d2-90-95-82", "b83f.d290.9582", "B83FD2909582"]:
    print(normalize(m))
```
All three print `B8:3F:D2:90:95:82`.

**Step 4: Inspect the flag bits.**

```python
first = int("B8", 16)          # 0b10111000
print("multicast", first & 1, "local", (first >> 1) & 1)
```
Output: `multicast 0 local 0`. It's a unicast address assigned at the factory.

### Your turn: finish it

Complete the normalizer so it inserts a colon after every two hex digits.

```text
import re

def normalize(mac):
    digits = re.sub(r"[:\-.]", "", mac)
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", digits):
        raise ValueError(mac)
    return ":".join(digits[i:i+2] for i in range(0, 12, ___)).upper()
```

<details>
<summary>Answer</summary>

`2`. `range(0, 12, 2)` yields 0, 2, 4 … 10, which gives six two-character octets.

</details>

### Your turn: on your own

A boot option reports `UefiDevicePath` = `PciRoot(0x0)/Pci(0x1C,0x4)/Pci(0x0,0x0)/MAC(0242AC110002,0x1)`. Give the normalized MAC and say whether it's factory-assigned or locally administered, and whether it's unicast or multicast.

<details>
<summary>Hint 1</summary>

First pull the 12 hex digits out of `MAC(...)`.

</details>

<details>
<summary>Hint 2</summary>

The answer is in the two lowest bits of the first octet: bit 0 for multicast, bit 1 for locally administered.

</details>

<details>
<summary>Hint 3</summary>

0x02 = 0b00000010.

</details>

<details>
<summary>Answer</summary>

`02:42:AC:11:00:02`. The first octet is 0x02. Bit 0 is 0, so it's unicast. Bit 1 is 1, so it's locally administered, meaning software set it, as Docker does. A server's factory NIC wouldn't normally look like this.

</details>

### Explain it

In your own words: Why does NICo look up BMC credentials by MAC instead of by IP address or hostname? What goes wrong if two sources write the same MAC in different formats and nobody normalizes them?

### Check

**1. Two records hold `b8:3f:d2:90:95:9a` and `B8-3F-D2-90-95-9A`, and a plain string comparison says they differ. What's the right fix?**

A. Normalize both to one canonical form before storing or comparing
B. Compare only the first three octets
C. Treat them as different devices
D. Compare their IP addresses instead

<details>
<summary>Answer</summary>

**A.** Normalize both to one canonical form before storing or comparing

They're the same 48-bit value. The first three octets only identify the vendor (the OUI), so many devices share them. IPs change, and a BMC may not even have one yet when it first appears on DHCP.

</details>

**2. Which Redfish field does NICo mark Critical for BMC identification and credential lookup?**

A. MACAddress under Managers/{id}/EthernetInterfaces
B. SerialNumber under Systems/{id}
C. PartNumber under Chassis/{id}
D. FirmwareVersion under Managers/{id}

<details>
<summary>Answer</summary>

**A.** MACAddress under Managers/{id}/EthernetInterfaces

The MAC of the manager (BMC) interface is the key for credentials. The system SerialNumber is also Critical, but for generating machine IDs and for pairing. PartNumber identifies BlueField models, and FirmwareVersion is used to track versions.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

<a id="pcie-device"></a>
## 6. PCIe device

### Before you read

- A GPU, a 400 Gb/s network card and an NVMe SSD all plug into a server motherboard. What do you think they have in common electrically?
- If you wanted to prove that a particular DPU card is installed in a particular host, which identifier on the card would you trust most?

<details>
<summary>Answers</summary>

- **A GPU, a 400 Gb/s network card and an NVMe SSD all plug into a server motherboard. What do you think they have in common electrically?** They're all PCI Express devices. They connect to the CPU over PCIe links, the firmware and OS find them at boot, and each one identifies itself with a vendor ID and a device ID.
- **If you wanted to prove that a particular DPU card is installed in a particular host, which identifier on the card would you trust most?** Its serial number. NICo's primary DPU-host pairing path matches the serial numbers of the host's PCIe devices against DPU serial numbers.

</details>

### Explanation

**PCI Express (PCIe)** is the high-speed point-to-point bus that connects expansion hardware to the CPU. A **PCIe device** is anything attached to it: NICs, DPUs, GPUs, NVMe drives, RAID controllers.

Terms:

- **Lanes and width**: a link has x1, x4, x8 or x16 lanes, and more lanes means more bandwidth. Each PCIe **generation** (Gen3, Gen4, Gen5 …) roughly doubles the speed per lane.
- **Root complex**: the part of the CPU where PCIe links start. A **PCIe switch** splits one link into several so more devices can attach.
- **Vendor ID and device ID**: 16-bit numbers that every device reports. `0x15b3` is Mellanox (now NVIDIA networking), `0x10de` is NVIDIA and `0x8086` is Intel. NICo's discovery data includes them, for example `"vendor": "0x15b3", "device": "0x101b"` for a ConnectX-6.
- **Class code**: what kind of device it is. `0200` is an Ethernet controller, `0207` an InfiniBand controller and `0302` a 3D controller, such as a datacenter GPU.
- **Function**: one physical card can expose several functions, and the OS sees each one as a separate device. A dual-port ConnectX-6 shows up as two.
- **Enumeration**: at boot, first the firmware and then the OS walk the bus and give every function an address. The PCI address lesson at the end of this chapter covers those addresses.

On Linux, `lspci` lists devices, and `/sys/bus/pci/devices/` has one directory per device.

NICo also sees PCIe devices **out-of-band** through Redfish. Most BMCs list them in the `Systems/{id}` response as a `PCIeDevices` array of links. Supermicro uses `Chassis/{id}/PCIeDevices` instead. Two fields are marked Critical:

- `SerialNumber` is the **primary DPU-host pairing** path. NICo matches it against DPU system serial numbers. A fallback path uses network-adapter serials, which must be visible to the host BMC.
- `PartNumber` identifies BlueField models (BF2, BF3, BF3 SuperNIC) through `is_bluefield_model()`.

With these two fields, NICo can use the host's own BMC to tell which DPU is installed in that host.

**Analogy.** PCIe is like a power strip wired straight to the CPU, where every plugged-in device has a label showing its manufacturer, model and serial number. The analogy breaks down because software discovers and addresses PCIe devices at boot, a device can split into several functions, and devices talk back over high-speed links. A power strip only delivers current.

### Worked example: List PCIe devices locally, then pair a DPU from Redfish data

**Step 1: List devices with IDs.**

Linux (install `pciutils` if needed):

```sh
lspci -nn | head
```
On macOS, run it inside Docker to see the Linux VM's virtual devices: `docker run --rm debian:stable-slim sh -c 'apt-get update -qq && apt-get install -y -qq pciutils >/dev/null && lspci -nn'`.

**Step 2: Read one line.**

A ConnectX-6 on a real server looks like this:

```text
ca:00.0 Infiniband controller [0207]: Mellanox Technologies MT28908 Family [ConnectX-6] [15b3:101b]
```
`ca:00.0` is the address, `[0207]` is the class and `[15b3:101b]` is the vendor:device ID pair.

**Step 3: See the same data in sysfs.**

```sh
ls /sys/bus/pci/devices/
cat /sys/bus/pci/devices/0000:00:00.0/vendor   # e.g. 0x8086
```
(Use any address from the `ls` output.)

**Step 4: Pair a host with a DPU by PCIe serial.**

This is simulated Redfish data. It includes a stray trailing space, which BMCs sometimes return:

```python
host_pcie = [
    {"Id": "236-0", "SerialNumber": "MT2243X01234 ", "PartNumber": "900-9D3B6-00CV-AA0"},
    {"Id": "23-0",  "SerialNumber": "1323722003211", "PartNumber": "699-2G133-0200-100"},
]
dpu_serials = {"MT2243X01234": "dpu-bmc-10.0.2.15"}
for dev in host_pcie:
    serial = dev["SerialNumber"].strip()
    if serial in dpu_serials:
        print(dev["Id"], "pairs with", dpu_serials[serial])
```
Output: `236-0 pairs with dpu-bmc-10.0.2.15`. Without `.strip()`, the match fails silently. NICo trims whitespace from chassis and network-adapter serials for the same reason.

### Your turn: finish it

Complete this filter so it keeps only PCIe devices from Mellanox/NVIDIA networking, using the vendor ID read from sysfs.

```text
import pathlib

for dev in sorted(pathlib.Path("/sys/bus/pci/devices").iterdir()):
    vendor = (dev / "vendor").read_text().strip()
    if vendor == "___":
        print(dev.name, (dev / "device").read_text().strip())
```

<details>
<summary>Answer</summary>

`0x15b3`. sysfs writes IDs in lowercase hex with a `0x` prefix. On a laptop the script will probably print nothing, which is the correct result.

</details>

### Your turn: on your own

From this `lspci -nn` line, name the PCI address, the class code and what it means, the vendor ID and the device ID:

```text
ca:00.1 Infiniband controller [0207]: Mellanox Technologies MT28908 Family [ConnectX-6] [15b3:101b]
```
Then explain why `ca:00.0` and `ca:00.1` can be the same physical card.

<details>
<summary>Hint 1</summary>

The address comes first. The bracketed numbers are the class, then vendor:device.

</details>

<details>
<summary>Hint 2</summary>

The part after the dot is the function number.

</details>

<details>
<summary>Hint 3</summary>

Each port of a dual-port NIC is a separate PCI function, so it looks like a separate device.

</details>

<details>
<summary>Answer</summary>

The address is `ca:00.1` (bus ca, device 00, function 1). Class `0207` means InfiniBand controller. Vendor `15b3` is Mellanox, and device `101b` is the MT28908 (ConnectX-6). `.0` and `.1` are two functions of one device, because each port of a dual-port ConnectX-6 appears as its own PCI function. Both report the same serial number.

</details>

### Explain it

In your own words: Why is a PCIe device's serial number, read from the *host's* BMC, a strong way to prove which DPU is physically installed in which host?

### Check

**1. In NICo's Redfish usage, what is the primary path for DPU-host pairing?**

A. Matching PCIe device SerialNumber against DPU system serial numbers
B. Matching the host's IP address with the DPU's IP address
C. Matching BIOS versions
D. Matching the PCIe device Id string

<details>
<summary>Answer</summary>

**A.** Matching PCIe device SerialNumber against DPU system serial numbers

The PCIe SerialNumber is marked Critical as the primary pairing path, and network-adapter serials are the fallback. IP addresses and BIOS versions don't identify a specific card, and Id is only used to keep track of devices.

</details>

**2. According to NICo's endpoint reference, where do Supermicro BMCs list PCIe devices?**

A. Chassis/{id}/PCIeDevices
B. Managers/{id}/PCIeDevices
C. UpdateService/PCIeDevices
D. Only in the host OS via lspci

<details>
<summary>Answer</summary>

**A.** Chassis/{id}/PCIeDevices

Supermicro uses the chassis path, while other vendors embed PCIeDevices links in the Systems/{id} response. Managers and UpdateService don't hold the device list. NICo also reads PCIe devices out-of-band, not only from the OS.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="numa-node"></a>
## 7. NUMA node

### Before you read

- A server has two CPU sockets, each with its own memory. Can socket 0 read memory attached to socket 1 as fast as its own memory?
- Guess: does a network card belong to a particular CPU socket?

<details>
<summary>Answers</summary>

- **A server has two CPU sockets, each with its own memory. Can socket 0 read memory attached to socket 1 as fast as its own memory?** No. Remote memory has to cross the link between the sockets, which is slower and has less bandwidth. That's NUMA: Non-Uniform Memory Access.
- **Guess: does a network card belong to a particular CPU socket?** Yes. Each PCIe device attaches to a root complex on one particular socket, so it has a NUMA node. Traffic between that NIC and a GPU or memory on the other socket has to cross the link between sockets.

</details>

### Explanation

In a multi-socket server, each CPU socket has its own memory controllers and its own PCIe root complexes. The hardware joins them into one machine, but access isn't uniform: a CPU core reaches its own *local* memory faster than memory attached to the other socket. This design is called **NUMA** (Non-Uniform Memory Access). A **NUMA node** is one locality domain: a group of CPU cores, the memory close to them and the PCIe devices attached to them. Some single-socket CPUs are also split into several NUMA nodes.

This matters for devices because a NIC, DPU or GPU attaches to one NUMA node. With GPUDirect RDMA, an InfiniBand NIC sends data straight from GPU memory. Performance is best when the NIC and GPU share a NUMA node, ideally the same PCIe switch. Otherwise the data crosses the link between sockets.

On Linux:

- `lscpu | grep -i numa` shows how many nodes there are and which CPUs belong to each.
- `/sys/bus/pci/devices/<addr>/numa_node` holds a device's node. `-1` means the platform didn't report one, which is common on laptops and VMs.
- `numactl --hardware` shows each node's memory size and the distances between nodes. On GPU servers, `nvidia-smi topo -m` shows how GPUs and NICs are connected.

In NICo, `PciDeviceProperties` has a `sint32 numa_node` field, and discovery reports it for each InfiniBand device (for example `"numa_node": 1`). NICo's designers discussed letting tenants select devices by NUMA node and decided against it, because it would add another selector to the API. Instead, device mapping is the same on every machine of an instance type. A tenant can create one test instance, check the locality, adjust which `device_instance` they pick and reuse that configuration on every other instance.

**Analogy.** Picture a restaurant with two kitchens, each with its own pantry. A cook can grab things from their own pantry quickly, but the other kitchen's pantry is a slow walk down a corridor. NUMA nodes are the kitchens, and devices are appliances installed in one kitchen or the other. The analogy breaks down because nothing stops a cook from using the far pantry. NUMA affects speed, not access: everything still works, just more slowly.

### Worked example: Inspect NUMA layout and device locality

**Step 1: Count NUMA nodes.**

```sh
lscpu | grep -i numa
```
A laptop shows `NUMA node(s): 1`. A two-socket server typically shows 2 or more, each with a list of CPUs.

**Step 2: See which CPUs belong to which node.**

```sh
for n in /sys/devices/system/node/node*; do echo "$(basename $n): $(cat $n/cpulist)"; done
```

**Step 3: Find each PCI device's node.**

```sh
for dev in /sys/bus/pci/devices/*; do
  echo "$(basename "$dev") numa=$(cat "$dev/numa_node")"
done | head
```
On a laptop or VM, expect `-1` or `0` for every device.

**Step 4: Interpret NICo discovery data.**

In the docs, a dual-port ConnectX-6 reports `"numa_node": 1` for both `0000:ca:00.0` and `0000:ca:00.1`. Both ports are on the same card, so they share a node. A GPU that also reports node 1 is local to them.

### Your turn: finish it

Complete the loop so it prints the NUMA node of every PCI device.

```text
for dev in /sys/bus/pci/devices/*; do
  echo "$(basename "$dev") numa=$(cat "$dev/___")"
done
```

<details>
<summary>Answer</summary>

`numa_node`. The sysfs file is `/sys/bus/pci/devices/<addr>/numa_node`.

</details>

### Your turn: on your own

A host reports two GPUs, GPU-A on NUMA node 0 and GPU-B on node 1, plus these InfiniBand devices, all on one fabric:

```json
[{"slot": "0000:1a:00.0", "numa_node": 0},
 {"slot": "0000:3c:00.0", "numa_node": 0},
 {"slot": "0000:9a:00.0", "numa_node": 1},
 {"slot": "0000:ca:00.0", "numa_node": 1}]
```
NICo sorts the devices by PCI slot and numbers them `device_instance` 0, 1, 2, 3. Which `device_instance` values give a job on GPU-B InfiniBand on its own NUMA node?

<details>
<summary>Hint 1</summary>

Sort by slot first. This list is already in sorted order.

</details>

<details>
<summary>Hint 2</summary>

Keep only the devices whose numa_node matches GPU-B's node.

</details>

<details>
<summary>Hint 3</summary>

GPU-B is on node 1, and the node-1 devices are 3rd and 4th in sorted order.

</details>

<details>
<summary>Answer</summary>

`device_instance` 2 (`0000:9a:00.0`) and 3 (`0000:ca:00.0`). Both are on NUMA node 1, the same node as GPU-B. The mapping is the same on every machine of the instance type, so this choice works on all of them.

</details>

### Explain it

In your own words: NICo chose not to add a NUMA selector to its tenant API. How does deterministic device mapping still let a performance-sensitive tenant get devices on the same NUMA node as their GPUs?

### Check

**1. `/sys/bus/pci/devices/0000:00:1f.6/numa_node` contains `-1`. What does that mean?**

A. The platform didn't report a NUMA node for this device
B. The device is broken
C. The device is on the last NUMA node
D. The device is attached to every node

<details>
<summary>Answer</summary>

**A.** The platform didn't report a NUMA node for this device

-1 is Linux's value for "unknown or not applicable", and it's typical on single-node laptops and VMs. It doesn't signal a fault, it isn't a count from the end like Python's -1, and a device never sits on every node.

</details>

**2. Why does NUMA locality between a NIC and a GPU matter?**

A. Traffic between them avoids crossing the slower inter-socket link
B. The GPU can't use a NIC on another NUMA node
C. It changes the NIC's MAC address
D. It decides which CPU architecture runs

<details>
<summary>Answer</summary>

**A.** Traffic between them avoids crossing the slower inter-socket link

NUMA affects performance, not correctness. Remote access works, just more slowly. It has nothing to do with MAC addresses or instruction sets.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="cpu-architectures"></a>
## 8. CPU architectures (amd64 vs arm64)

### Before you read

- You copy a compiled program from your x86 laptop to a Raspberry Pi and run it. What do you expect?
- Guess: why does the same architecture show up as both `aarch64` and `arm64`?

<details>
<summary>Answers</summary>

- **You copy a compiled program from your x86 laptop to a Raspberry Pi and run it. What do you expect?** It fails, usually with `exec format error` or `cannot execute binary file`. The Pi's Arm CPU doesn't understand x86 machine code.
- **Guess: why does the same architecture show up as both `aarch64` and `arm64`?** Different ecosystems chose different names. The Linux kernel and `uname -m` say aarch64, while Docker, Go, Debian and macOS say arm64. x86-64 has the same split: `x86_64` versus `amd64`.

</details>

### Explanation

A **CPU architecture**, or **instruction set architecture (ISA)**, is the set of machine instructions a processor understands, along with how they're encoded, the registers and the calling conventions. A compiled binary is a sequence of those instructions, so a binary built for one architecture can't run natively on another.

The two you'll see:

- **amd64**, also called **x86_64** or **x86-64**: 64-bit x86, used by Intel and AMD server CPUs and most PCs. The name comes from AMD, which designed the 64-bit extension.
- **arm64**, also called **aarch64**: 64-bit Arm, used by Apple Silicon Macs, NVIDIA Grace CPUs, AWS Graviton and the Arm cores on BlueField DPUs.

This matters for NICo because one ManagedHost mixes both. The Host is typically an x86 machine. The DPU has its own Arm processor, its own operating system and its own BMC. Software that runs on the DPU, such as `dpu-agent`, has to be built for arm64. Host-side tools are usually amd64, though Arm-based hosts exist too.

There are three ways around the mismatch:

- **Build for the target**: cross-compile, for example with `GOOS=linux GOARCH=arm64 go build` or `docker buildx build --platform linux/arm64`.
- **Multi-arch images**: one image tag whose manifest points to both an amd64 build and an arm64 build. The container runtime pulls the one that matches its CPU.
- **Emulation**: QEMU can translate foreign instructions, slowly. Linux's binfmt_misc can call it automatically. A later chapter covers this.

The tell-tale error is `exec format error`. In Kubernetes it often shows up as a container that crashes immediately and keeps restarting (a crash loop).

**Analogy.** An ISA is like the language a factory's machines are wired to understand. Instructions written in any other language are just noise to them. The analogy breaks down because a person can learn a new language and a CPU can't. Either software translates the instructions (emulation, which is slow), or you produce them again in the CPU's own language (recompiling).

### Worked example: Identify architectures and see a mismatch

**Step 1: Check your CPU.**

```sh
uname -m
```
A Linux PC prints `x86_64`, Arm Linux prints `aarch64` and an Apple Silicon Mac prints `arm64`.

**Step 2: Check a binary.**

```sh
file "$(command -v ls)"
```
On Linux the output contains `ELF 64-bit LSB … x86-64` or `ARM aarch64`. On macOS it says `Mach-O … arm64` or `x86_64`. Some macOS system binaries are universal and list both.

**Step 3: Check an image's architecture.**

```sh
docker pull alpine
docker image inspect --format '{{.Os}}/{{.Architecture}}' alpine
```
Docker uses the `amd64`/`arm64` names.

**Step 4: Run the other architecture.**

```sh
docker run --rm --platform linux/arm64 alpine uname -m   # on an x86 machine
docker run --rm --platform linux/amd64 alpine uname -m   # on an Arm machine
```
Docker Desktop includes emulation, so this prints the foreign architecture. On plain Docker Engine for Linux with no emulation registered, you'll see `exec format error`. That's the native mismatch, and the binfmt chapter shows how to fix it.

### Your turn: finish it

Complete the function that converts `uname -m` output into Docker/Go architecture names.

```text
def docker_arch(uname_m):
    return {"x86_64": "amd64", "aarch64": ___, "arm64": "arm64"}[uname_m]

print(docker_arch("aarch64"))
```

<details>
<summary>Answer</summary>

`"arm64"`, with the quotes, because it's a Python string. aarch64 and arm64 are two names for the same ISA.

</details>

### Your turn: on your own

You build a container image on an Apple Silicon Mac with plain `docker build -t registry.example.com/team/tool:1.0 .`, push it, and deploy it to an x86 Kubernetes cluster. The pod logs show `exec format error`. Explain why and give a command that fixes it.

<details>
<summary>Hint 1</summary>

What architecture does `docker build` target by default?

</details>

<details>
<summary>Hint 2</summary>

The cluster nodes are amd64 and your Mac is arm64.

</details>

<details>
<summary>Hint 3</summary>

buildx takes a `--platform` flag, and the flag can list more than one platform.

</details>

<details>
<summary>Answer</summary>

By default, `docker build` builds for the architecture of the machine it runs on. The image contains arm64 binaries, which x86 nodes can't execute. To fix it, build for amd64:

```sh
docker buildx build --platform linux/amd64 -t registry.example.com/team/tool:1.0 --push .
```
Use a tag that includes your registry and namespace. A bare name like `tool` would try to push to Docker Hub's official `library/` namespace and fail.

To make one tag that works on both x86 hosts and Arm DPUs, use `--platform linux/amd64,linux/arm64`. Multi-platform builds may first need a builder that supports them, created with `docker buildx create --use` (the docker-container driver), or Docker's containerd image store turned on.

</details>

### Explain it

In your own words: A NICo-managed host and its DPU often have different CPU architectures. Why does that force NICo's build and release process to care about architecture for every component that runs on the DPU?

### Check

**1. Which pair names the same architecture?**

A. aarch64 and arm64
B. amd64 and arm64
C. x86_64 and aarch64
D. amd64 and i386

<details>
<summary>Answer</summary>

**A.** aarch64 and arm64

aarch64 (the kernel and uname name) and arm64 (the Docker, Go and Apple name) are the same 64-bit Arm ISA. amd64 is x86_64, so it doesn't pair with arm64 or aarch64. i386 is the older 32-bit x86.

</details>

**2. A BlueField DPU's processor is…**

A. Arm-based, so DPU software must be built for arm64
B. x86, the same as the host
C. Able to run any binary because it is a NIC
D. Unable to run its own operating system

<details>
<summary>Answer</summary>

**A.** Arm-based, so DPU software must be built for arm64

NICo's glossary says the DPU has its own Arm processor, operating system and BMC. Being a network card doesn't let it run binaries built for another architecture.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="server-hardware-basics"></a>
## 9. Server hardware basics

### Before you read

- A server's operating system has crashed. How could you still power-cycle it and change its BIOS settings from across the building?
- What does "2U" mean on a server spec sheet?

<details>
<summary>Answers</summary>

- **A server's operating system has crashed. How could you still power-cycle it and change its BIOS settings from across the building?** Through its BMC, a small separate computer on the motherboard with its own network port and standby power. You reach it out-of-band, which today usually means the Redfish HTTP API.
- **What does "2U" mean on a server spec sheet?** The server is two rack units tall. One U is 1.75 inches (44.45 mm), and a common full-height rack is 42U.

</details>

### Explanation

A rack server is a PC built for density, uptime and remote management. Inside the **chassis** you'll find:

- **CPUs**: usually one or two sockets, sometimes more. Each socket is one or more NUMA nodes, with its own memory and PCIe lanes.
- **Memory**: DIMMs in channels attached to each socket. This is usually ECC memory, which detects and corrects bit errors.
- **Drives**: NVMe SSDs (on PCIe) or SATA/SAS drives, sometimes behind a RAID controller.
- **NICs and accelerators**: PCIe cards such as Ethernet or InfiniBand NICs, DPUs and GPUs. Some GPU systems use dedicated boards and trays instead.
- **Power and cooling**: usually redundant power supplies (PSUs), so the server keeps running if one fails, and fans that can be swapped while it's running.
- **BMC (Baseboard Management Controller)**: a small independent computer on the board. It runs on standby power whenever the server is plugged in, even when the server is "off". It controls power, reads sensors, provides a console, manages BIOS settings and serves a **Redfish** API on its own management network port. Managing a server through the BMC is **out-of-band (OOB)** management. Managing it through the running OS is **in-band**.
- **Firmware**: UEFI/BIOS (which boots the machine), BMC firmware, and firmware on NICs, drives and other components. All of it needs version tracking and updates.

**Racks** hold servers stacked in U-sized slots, along with power distribution units (PDUs) and usually a **top-of-rack (ToR) switch** that connects the servers to the datacenter network. The BMCs are usually connected through a separate management network.

In NICo, the unit of management is a **ManagedHost**: one Host Machine plus its attached DPU Machines. The Host has a BMC and each DPU has its own, so the common case of one host with one DPU involves two BMCs. Redfish groups what a BMC knows into resources:

- `Systems`: the computer itself, with its serial number, power state, boot order and PCIe devices.
- `Chassis`: the physical enclosure, with serial and part numbers.
- `Managers`: the BMC itself.
- `UpdateService`: the firmware inventory.

The system `SerialNumber` is marked Critical because NICo generates machine IDs from it.

**Analogy.** A server is like a building with a separate security office (the BMC) that has its own power line and phone line. If the building's main systems fail, the security office can still switch the lights off and on, check the thermostats and let a repair crew in. The analogy breaks down because the BMC can also rewrite the building's foundations, meaning the BIOS and firmware. That's why protecting BMC credentials matters so much.

### Worked example: Inventory your own machine the way a server is inventoried

**Step 1: CPU and memory.**

Linux: `lscpu | head -20` and `free -h`. macOS: `system_profiler SPHardwareDataType`. Note the socket count and NUMA nodes from the earlier lessons.

**Step 2: Drives and NICs.**

Linux: `lsblk -d -o NAME,SIZE,MODEL` and `ip -br link`. NVMe drives and NICs also appear in `lspci`, because they're PCIe devices.

**Step 3: Firmware-level identity.**

Linux: `sudo dmidecode -s system-serial-number` and `sudo dmidecode -s bios-version`. This DMI/SMBIOS data comes from the firmware, not the OS. VMs may print placeholder values.

**Step 4: Map it to Redfish.**

A real BMC returns the same kind of facts over HTTP. Here is `GET /redfish/v1/Systems/{id}` from NICo's docs:

```json
{
  "Id": "System.Embedded.1",
  "SerialNumber": "J1234XY",
  "PowerState": "On",
  "Manufacturer": "Dell Inc.",
  "Model": "PowerEdge R750",
  "PCIeDevices": [{ "@odata.id": "/redfish/v1/Systems/System.Embedded.1/PCIeDevices/236-0" }]
}
```
The serial matches what dmidecode reports in-band. PowerState can be read even when the OS is down, and PCIeDevices links to the installed cards.

### Your turn: finish it

Fill in what each Redfish resource describes.

```text
/redfish/v1/Systems/{id}         -> ___
/redfish/v1/Chassis/{id}         -> physical enclosure or card: serial, part number, power/thermal
/redfish/v1/Managers/{id}        -> ___
/redfish/v1/UpdateService/FirmwareInventory -> firmware components and versions
```

<details>
<summary>Answer</summary>

Systems: the computer system itself, with its serial number, power state, boot order, PCIe devices and Ethernet interfaces. Managers: the BMC (management controller) itself, with its ID, firmware version and its own network interfaces.

</details>

### Your turn: on your own

A ManagedHost has one x86 Host and one BlueField DPU. (1) How many BMCs are involved? (2) Over which kind of network does NICo reach them, and why not through the Host OS? (3) Which Redfish field does NICo need to generate the Host's machine ID?

<details>
<summary>Hint 1</summary>

The DPU is a computer in its own right.

</details>

<details>
<summary>Hint 2</summary>

Think about what's still reachable while a tenant's OS is broken or being reinstalled.

</details>

<details>
<summary>Hint 3</summary>

The field is marked Critical under Systems.

</details>

<details>
<summary>Answer</summary>

(1) Two: the Host BMC and the DPU BMC. (2) Out-of-band management networks. The BMCs don't depend on the Host OS, so NICo can discover, power-cycle and repair machines even when the tenant OS is down. (3) `SerialNumber` from `/redfish/v1/Systems/{id}`. Pairing fails without it.

</details>

### Explain it

In your own words: Why does a bare-metal provisioning system have to manage servers through the BMC instead of by logging into the operating system?

### Check

**1. When does a server's BMC run?**

A. Whenever the server has power, even if the host is off
B. Only while the host OS is running
C. Only during boot
D. Only when a technician plugs in a laptop

<details>
<summary>Answer</summary>

**A.** Whenever the server has power, even if the host is off

The BMC runs on standby power, which is why it can power the host on. It doesn't depend on the host OS or on the boot process, and it's reachable over its management network port with nobody on site.

</details>

**2. In NICo, what is a ManagedHost?**

A. One Host Machine grouped with its attached DPU Machines
B. Any server that has a BMC
C. A rack of servers
D. A virtual machine running on a host

<details>
<summary>Answer</summary>

**A.** One Host Machine grouped with its attached DPU Machines

The glossary defines a ManagedHost as one physical box: the Host plus its DPUs. Having a BMC doesn't make something a ManagedHost, and the term doesn't mean a whole rack or a VM.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="pci-device-and-slot-address"></a>
## 10. PCI device and slot address

*Builds on: PCIe device (ch. 1)*

### Before you read

- Look at `0000:ca:00.0`. It has four parts. Guess what each one is.
- Linux names the device at `ca:00.0` `ibp202s0f0`. Where does 202 come from?

<details>
<summary>Answers</summary>

- **Look at `0000:ca:00.0`. It has four parts. Guess what each one is.** domain : bus : device . function. Here that's domain 0000, bus ca, device 00 and function 0. Every number is hexadecimal.
- **Linux names the device at `ca:00.0` `ibp202s0f0`. Where does 202 come from?** 0xca = 202. Linux's predictable interface names give the bus in decimal (p202), then the slot or device (s0), then the function (f0).

</details>

### Explanation

Every PCI function in a machine has an address of the form **`DDDD:BB:DD.F`**, written in hex:

| Part | Example | Meaning | Range |
|---|---|---|---|
| Domain (segment) | `0000` | an independent PCI hierarchy | usually 0000; big systems have more |
| Bus | `ca` | which bus behind a root port or bridge | 00–ff (0–255) |
| Device | `00` | the device on that bus ("slot") | 00–1f (0–31) |
| Function | `0` | which function of a multi-function device | 0–7 |

This is the **BDF** (bus/device/function), also called the **PCI slot address**. `lspci` usually leaves out domain 0000 and prints `ca:00.0`. sysfs uses the full form. Linux interface names often encode the address, so `ibp202s0f1` means bus 202 (0xca), slot 0, function 1.

NICo cares about this for two reasons.

First, stability. Machines with identical hardware get the same PCI addresses, while OS device paths change with the driver. So NICo's InfiniBand design stores the PCI **slot**, for example `"slot": "0000:ca:00.0"`, instead of the OS-specific `path`.

Second, **deterministic selection**. A tenant asks for `{device: "MT28908 Family [ConnectX-6]", fabric: "IbFabric1", device_instance: 1}`. Those fields are the same on every machine of an instance type, so the request needs no serial number or GUID. To map the request to hardware, NICo filters to the matching devices, **sorts them by PCI slot** and takes the Nth one. The designers rejected sorting by hardware GUID. GUIDs differ from machine to machine, so the "second" device would sometimes be in a different physical slot. Sorting by slot means a given request always lands on the same piece of hardware on every machine of the type.

When you sort, compare the parts as numbers. Plain string sorting breaks when the letter case is mixed (`EA` sorts before `cb`) or when a domain is wider than four digits.

**Analogy.** A PCI address is like a postal address: city (domain), street (bus), house number (device) and flat number (function). Sorting by address puts the homes on every identical housing estate in the same order. The analogy breaks down because PCI addresses are assigned when the bus is enumerated at boot. A firmware change or an added card can renumber the buses, which is why NICo relies on them only across machines with the same hardware configuration.

### Worked example: Decode addresses and run NICo's selection rule

**Step 1: Decode one address.**

`0000:cd:00.0` is domain 0, bus 0xcd (205), device 0, function 0. Its typical Linux InfiniBand name is `ibp205s0f0`.

```sh
printf '%d\n' 0xcd   # 205
```

**Step 2: Take the hardware list.**

In NICo's docs (Example 2), one host has four ConnectX-6 devices:

| guid | fabric | slot |
|---|---|---|
| 1234 | IbFabric1 | 0000:cb:00.0 |
| 2345 | IbFabric2 | 0000:cd:00.0 |
| 3456 | IbFabric1 | 0000:ea:00.0 |
| 4567 | IbFabric2 | 0000:eb:00.0 |

**Step 3: Filter, sort by slot, pick the Nth.**

```python
devs = [("4567", "IbFabric2", "0000:eb:00.0"), ("1234", "IbFabric1", "0000:cb:00.0"),
        ("3456", "IbFabric1", "0000:ea:00.0"), ("2345", "IbFabric2", "0000:cd:00.0")]

def slot_key(slot):
    domain, bus, rest = slot.split(":")
    device, function = rest.split(".")
    return (int(domain, 16), int(bus, 16), int(device, 16), int(function, 16))

def select(fabric, n):
    matches = sorted((d for d in devs if d[1] == fabric), key=lambda d: slot_key(d[2]))
    return matches[n][0]

print(select("IbFabric1", 0), select("IbFabric1", 1), select("IbFabric2", 0))
```
Output: `1234 3456 2345`, which matches the docs.

**Step 4: See why string sorting is fragile.**

```python
print(sorted(["0000:cb:00.0", "0000:EA:00.0"]))
print(sorted(["0000:cb:00.0", "0000:EA:00.0"], key=slot_key))
```
The plain sort puts `EA` first, because uppercase letters sort before lowercase. The numeric key correctly puts `cb` (203) before `ea` (234).

### Your turn: finish it

Complete `slot_key` so it splits off the function and parses the bus as hex. There are two blanks.

```text
def slot_key(slot):
    domain, bus, rest = slot.split(":")
    device, function = rest.split(___)
    return (int(domain, 16), int(bus, ___), int(device, 16), int(function, 16))
```

<details>
<summary>Answer</summary>

The first blank is `"."`, because a dot separates the device and the function. The second blank is `16`, because bus numbers are hex (`ca` is 202).

</details>

### Your turn: on your own

Using the four-device table from the worked example: (1) Which GUID does `{fabric: "IbFabric2", device_instance: 1}` select? (2) Suppose NICo sorted by GUID instead, and on another machine of the same type the IbFabric1 devices had GUIDs `cb:00.0 → 9a01` and `ea:00.0 → 1f02`. Which slot would `device_instance: 0` select on that machine, and why is that a problem?

<details>
<summary>Hint 1</summary>

For (1), filter to IbFabric2 and sort by slot. cd comes before eb.

</details>

<details>
<summary>Hint 2</summary>

For (2), sort the two GUIDs as strings: "1f02" < "9a01".

</details>

<details>
<summary>Hint 3</summary>

The same request would land on a different physical slot on different machines.

</details>

<details>
<summary>Answer</summary>

(1) `4567` (slot `0000:eb:00.0`). (2) GUID order puts `1f02` first, so `device_instance: 0` would select `0000:ea:00.0` on that machine but `0000:cb:00.0` on the machine in the docs. The same tenant config would map to different hardware, possibly with a different NUMA node or different cabling. Sorting by slot avoids this.

</details>

### Explain it

In your own words: Why does sorting by PCI slot give tenants stable device selection across machines of the same instance type, when sorting by GUID doesn't?

### Check

**1. In `0000:ca:00.1`, what is the `1`?**

A. The PCI function number
B. The NUMA node
C. The port's bus number
D. The domain

<details>
<summary>Answer</summary>

**A.** The PCI function number

The format is domain:bus:device.function, so the digit after the dot is the function. Here it's the second port of a dual-port NIC. The NUMA node isn't part of the address at all.

</details>

**2. Why does NICo's design store the PCI `slot` rather than the sysfs `path`?**

A. The path depends on the OS and driver, while the slot is stable for identical hardware
B. The path is longer, which wastes database space
C. The slot includes the MAC address
D. Tenants need to type the path

<details>
<summary>Answer</summary>

**A.** The path depends on the OS and driver, while the slot is stable for identical hardware

The docs say the path is very specific to the OS and driver, and it differs between Mellanox drivers. Storage size isn't the reason, a slot contains no MAC, and tenants select devices by name, fabric and instance number, not by path.

</details>

**3. What is bus `ca` in decimal?**

A. 202
B. 110
C. 12
D. ca has no decimal value

<details>
<summary>Answer</summary>

**A.** 202

0xca = 12×16 + 10 = 202, which is why the Linux name is ibp202s0f0. 110 comes from misreading the digits, and 12 is only the value of the first hex digit.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="build-task"></a>
## Build task: Site-inventory resolver

**Goal:** Build a Python script that reads a TOML site file and YAML discovery data, normalizes BMC MAC addresses and loads everything into SQLite. It then reports which expected machines were discovered and resolves tenant InfiniBand selections (device, fabric, device_instance) to exact PCI slots, the same way every time.

**Why it matters for NICo:** This is a laptop-sized version of real NICo work. Expected machines are matched to discovered BMCs by MAC, which is how NICo looks up initial BMC credentials. The data lives in relational tables. Tenant device selections are mapped to hardware by sorting PCI slots, never GUIDs. The data contains traps: a MAC that YAML mangles, MACs in mixed formats, an uppercase PCI address, and GUIDs that sort in a different order from the slots. These are the kinds of bugs that break pairing and device selection in production.

**You need:**

- Python 3.11 or newer, for the built-in `tomllib`. Check with `python3 --version`.
- PyYAML: `python3 -m venv .venv && . .venv/bin/activate && pip install pyyaml`
- Or skip local Python and use Docker/Podman: `docker run --rm -v "$PWD":/work -w /work python:3.12-slim sh -c "pip install -q --root-user-action=ignore pyyaml && python resolver.py"`
- sqlite3 comes with Python, so there's nothing else to install.

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the data files</summary>

Run `mkdir inventory && cd inventory`, then create these three files exactly as shown.

`site.toml`:
```toml
site_name = "lab-west"

[defaults]
fabric = "IbFabric1"

[[racks]]
name = "R01"
row = "A"

[[racks]]
name = "R02"
row = "A"

[[expected_machines]]
serial = "J1234XY"
rack = "R01"
bmc_mac = "B8:3F:D2:90:95:82"

[[expected_machines]]
serial = "K5678ZW"
rack = "R01"
bmc_mac = "b8-3f-d2-90-95-9a"

[[expected_machines]]
serial = "M9012QR"
rack = "R02"
bmc_mac = "500012345601"
```

`discovered.yaml`:
```yaml
hosts:
  - bmc_mac: b8:3f:d2:90:95:82
    arch: x86_64
    ib_devices:
      - slot: "0000:eb:00.0"
        guid: "0a17"
        fabric: IbFabric2
        numa_node: 1
        device: "MT28908 Family [ConnectX-6]"
      - slot: "0000:EA:00.0"
        guid: "1f02"
        fabric: IbFabric1
        numa_node: 1
        device: "MT28908 Family [ConnectX-6]"
      - slot: "0000:cd:00.0"
        guid: "c3d4"
        fabric: IbFabric2
        numa_node: 0
        device: "MT28908 Family [ConnectX-6]"
      - slot: "0000:cb:00.0"
        guid: "9a01"
        fabric: IbFabric1
        numa_node: 0
        device: "MT28908 Family [ConnectX-6]"
  - bmc_mac: B8:3F:D2:90:95:9A
    arch: x86_64
  - bmc_mac: 50:00:12:34:56:01
    arch: aarch64
  - bmc_mac: 02:42:ac:11:00:02
    arch: x86_64
```

`requests.yaml`:
```yaml
requests:
  - host: J1234XY
    device: "MT28908 Family [ConnectX-6]"
    fabric: IbFabric1
    device_instance: 1
  - host: J1234XY
    device: "MT28908 Family [ConnectX-6]"
    fabric: IbFabric2
    device_instance: 0
  - host: J1234XY
    device: "MT28908 Family [ConnectX-6]"
    device_instance: 0
  - host: J1234XY
    device: "MT28908 Family [ConnectX-6]"
    fabric: IbFabric2
    device_instance: 2
```
The third request has no `fabric`, so it should fall back to `defaults.fabric` from the TOML file.

</details>

<details>
<summary>Step 2: Load both formats and inspect the types</summary>

Start `resolver.py`:
```python
import re
import sqlite3
import tomllib

import yaml

with open("site.toml", "rb") as f:
    site = tomllib.load(f)
with open("discovered.yaml") as f:
    discovered = yaml.safe_load(f)
with open("requests.yaml") as f:
    requests = yaml.safe_load(f)["requests"]
```
Temporarily add `print([type(h["bmc_mac"]).__name__ for h in discovered["hosts"]])` and run the script. If any entry isn't `str`, work out why before you go on. Fix the **data file**, not the code. Remove the print when you're done.

</details>

<details>
<summary>Step 3: Normalize MACs and parse PCI slots</summary>

Add two helpers:
```python
ARCH = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}


def normalize_mac(raw):
    if not isinstance(raw, str):
        raise ValueError(f"MAC {raw!r} loaded as {type(raw).__name__}, not str: quote it in the YAML")
    digits = re.sub(r"[:\-.]", "", raw)
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", digits):
        raise ValueError(f"not a MAC address: {raw!r}")
    return ":".join(digits[i:i + 2] for i in range(0, 12, 2)).upper()


def slot_key(slot):
    m = re.fullmatch(r"([0-9a-f]+):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])", slot.lower())
    if not m:
        raise ValueError(f"not a PCI address: {slot!r}")
    return tuple(int(part, 16) for part in m.groups())
```

</details>

<details>
<summary>Step 4: Create tables and load the data</summary>

```python
db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE expected_machine (serial TEXT PRIMARY KEY, rack TEXT NOT NULL, bmc_mac TEXT NOT NULL UNIQUE);
CREATE TABLE discovered_host (bmc_mac TEXT PRIMARY KEY, arch TEXT NOT NULL);
CREATE TABLE ib_device (bmc_mac TEXT NOT NULL REFERENCES discovered_host(bmc_mac),
                        slot TEXT NOT NULL, guid TEXT NOT NULL, fabric TEXT NOT NULL,
                        numa_node INTEGER, device TEXT NOT NULL);
""")
for m in site["expected_machines"]:
    db.execute("INSERT INTO expected_machine VALUES (?, ?, ?)",
               (m["serial"], m["rack"], normalize_mac(m["bmc_mac"])))
for h in discovered["hosts"]:
    mac = normalize_mac(h["bmc_mac"])
    db.execute("INSERT INTO discovered_host VALUES (?, ?)", (mac, ARCH[h["arch"]]))
    for d in h.get("ib_devices", []):
        db.execute("INSERT INTO ib_device VALUES (?, ?, ?, ?, ?, ?)",
                   (mac, d["slot"].lower(), d["guid"], d["fabric"], d["numa_node"], d["device"]))
```
Every MAC goes through `normalize_mac` *before* it reaches the database, so the joins always compare MACs in the same format.

</details>

<details>
<summary>Step 5: Print the pairing report with LEFT JOINs</summary>

```python
print(f"site {site['site_name']}")
print("== pairing ==")
for serial, rack, mac, arch in db.execute("""
        SELECT e.serial, e.rack, e.bmc_mac, d.arch
        FROM expected_machine e LEFT JOIN discovered_host d ON d.bmc_mac = e.bmc_mac
        ORDER BY e.serial"""):
    print(f"{serial} {rack} {mac} {arch or 'NOT DISCOVERED'}")
for (mac,) in db.execute("""
        SELECT d.bmc_mac FROM discovered_host d
        LEFT JOIN expected_machine e ON e.bmc_mac = d.bmc_mac
        WHERE e.serial IS NULL ORDER BY d.bmc_mac"""):
    print(f"UNEXPECTED {mac}")
```

</details>

<details>
<summary>Step 6: Resolve selections by PCI slot</summary>

```python
print("== selections ==")
default_fabric = site["defaults"]["fabric"]
for r in requests:
    fabric = r.get("fabric", default_fabric)
    n = r.get("device_instance", 0)
    candidates = db.execute("""
        SELECT i.slot, i.guid, i.numa_node FROM ib_device i
        JOIN expected_machine e ON e.bmc_mac = i.bmc_mac
        WHERE e.serial = ? AND i.device = ? AND i.fabric = ?""",
        (r["host"], r["device"], fabric)).fetchall()
    candidates.sort(key=lambda row: slot_key(row[0]))
    label = f"{r['host']} {fabric} #{n}"
    if n < len(candidates):
        slot, guid, numa = candidates[n]
        print(f"{label} -> {slot} guid={guid} numa={numa}")
    else:
        print(f"{label} -> ERROR only {len(candidates)} matching device(s)")
```

</details>

<details>
<summary>Step 7: Write the expected output and compare</summary>

```sh
cat > expected.txt <<'EOF'
site lab-west
== pairing ==
J1234XY R01 B8:3F:D2:90:95:82 amd64
K5678ZW R01 B8:3F:D2:90:95:9A amd64
M9012QR R02 50:00:12:34:56:01 arm64
UNEXPECTED 02:42:AC:11:00:02
== selections ==
J1234XY IbFabric1 #1 -> 0000:ea:00.0 guid=1f02 numa=1
J1234XY IbFabric2 #0 -> 0000:cd:00.0 guid=c3d4 numa=0
J1234XY IbFabric1 #0 -> 0000:cb:00.0 guid=9a01 numa=0
J1234XY IbFabric2 #2 -> ERROR only 2 matching device(s)
EOF
```
Then run the verify command.

</details>

**Check it works:** From the `inventory` directory, run `python3 resolver.py > out.txt && diff expected.txt out.txt && echo PASS`. With Docker, run `docker run --rm -v "$PWD":/work -w /work python:3.12-slim sh -c "pip install -q --root-user-action=ignore pyyaml && python resolver.py" > out.txt && diff expected.txt out.txt && echo PASS`. You're done when it prints `PASS` and no diff lines. pip writes its notices to stderr, so they don't end up in out.txt.

<details>
<summary>If you get stuck</summary>

- `ValueError: MAC 38882717761 loaded as int, not str`: PyYAML (YAML 1.1) read the unquoted `50:00:12:34:56:01` as a base-60 integer. Change that line in discovered.yaml to `  - bmc_mac: "50:00:12:34:56:01"`. The hex MACs survived only because they contain letters.
- `ModuleNotFoundError: No module named 'tomllib'`: your Python is older than 3.11. Use the Docker command or install a newer Python.
- `TypeError: File must be opened in binary mode`: `tomllib.load` needs `open("site.toml", "rb")`.
- If `IbFabric1 #1` gives `0000:cb:00.0` and `#0` gives `0000:ea:00.0` (or `0000:EA:00.0`), you sorted by GUID or by the raw slot string. As text, the uppercase `EA` sorts before `cb`. Sort with `slot_key`, and store slots in lowercase.
- If K5678ZW shows `NOT DISCOVERED`, the MACs weren't normalized before they were inserted. `b8-3f-d2-90-95-9a` and `B8:3F:D2:90:95:9A` have to end up as the same string.
- `UNIQUE constraint failed` on a second run means you switched to a database file and loaded the data twice. Delete the file, or keep using `:memory:`.

</details>

**Stretch goal:** Add Protocol Buffers. Write `inventory.proto` with an `InfinibandDevice` message: fields `guid` and `fabric`, plus a nested `PciDeviceProperties` message with `slot`, `device` and `sint32 numa_node`. Compile it with `python -m grpc_tools.protoc -I. --python_out=. inventory.proto`. Make the resolver also write each successful selection to `selections.bin` as a serialized message with a length prefix. Then write a second script that reads `selections.bin` back and prints each message with `MessageToJson`. Check that its slots and GUIDs match the text report.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 7 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Protocol Buffers): The completion-problem answer says that using `slot = 3` 'would make old readers read the slot bytes as `path`'. But `path = 3` is in the same message (PciDeviceProperties), so protoc rejects the schema with a duplicate field-number error. Old readers could only misread the bytes if `path` were removed and its number later reused. *Fix:* Reword it: 'You can't use `slot = 3`: protoc rejects a number already used in the same message. And if `path` were ever removed, reusing 3 for `slot` would make old readers read the slot bytes as `path`. Reserve retired numbers instead.'
- **minor** (YAML): In 'Get PyYAML', the Docker alternative (`sh -c "pip install -q pyyaml && python"`) leaves the learner at a Python REPL. The next step is a shell command (`python3 -c ... <<'EOF'`) that can't be run from that prompt. *Fix:* Make the Docker option start a shell, e.g. `docker run --rm -it python:3.12-slim sh -c "pip install -q pyyaml && exec sh"`, then run the next step's command there.

---

[02-software-linux-basics.md →](02-software-linux-basics.md)
