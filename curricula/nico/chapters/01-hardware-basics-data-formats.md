# Chapter 1: Hardware Basics · Data & Formats

*Part: Foundations · 10 concepts · [curriculum](../curriculum.md#chapter-1)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo (NVIDIA Infra Controller) manages physical servers. You won't get far with it until two kinds of vocabulary feel natural: **hardware** (servers, BMCs, PCIe devices, NUMA nodes, CPU architectures, MAC and PCI addresses) and **data formats** (TOML, YAML, Protocol Buffers, SQL). This chapter covers both. It assumes only that you can program a little and use a terminal.

Each idea here shows up again later in the course. NICo's site configuration is written in TOML. Its Core APIs are defined in Protocol Buffers. It keeps machine state in relational database tables, and you deploy it with Helm charts, which are YAML. When it discovers hardware, it reads MAC addresses and PCIe serial numbers out of band through Redfish, the BMC's HTTP API, and uses them to pair DPUs with hosts and to look up BMC credentials. Separately, an in-band discovery tool (scout) running on the machine reports InfiniBand devices with their PCI slot addresses and NUMA nodes, and NICo uses those slots to map a tenant's device selection to one physical InfiniBand port.

The lessons are short and practical. Each one starts with a question to guess at, then explains the idea, works an example step by step, and gives you problems that come with less and less help. Everything runs on a normal laptop. The chapter ends with a small tool that combines all ten concepts: a toy inventory resolver that reads TOML and YAML, normalises MACs, loads SQLite, sorts PCI addresses the way NICo does, and serialises the results with protobuf.

**By the end of this chapter you can:**

- Read and write TOML, YAML and Protocol Buffers schemas, and spot the common parsing traps in each
- Model and query inventory data in a relational database with SQL joins and constraints
- Explain how servers are built and managed out of band through a BMC, and match Redfish resources (Systems, Chassis, Managers) to physical parts
- Normalise MAC addresses and explain why NICo uses them as keys for BMC credentials and DPU-host pairing
- Decode PCI addresses, find a device's NUMA node, and map a tenant's device selection to hardware deterministically by sorting PCI slots
- Tell amd64 binaries from arm64 binaries and predict when one will fail to run

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
11. [Build task: Build a toy site-inventory resolver](#build-task)

<a id="toml"></a>
## 1. TOML

### Before you read

- In this file, what do you think `[server]` does, and what is the full name of `port`?
```toml
[server]
port = 8080
```
- Guess: is `port = "8080"` the same as `port = 8080` in TOML?

<details>
<summary>Answers</summary>

- **In this file, what do you think `[server]` does, and what is the full name of `port`?
```toml
[server]
port = 8080
```** `[server]` opens a table (a named group of keys). Every key after it belongs to that table until the next header, so the full name is `server.port`, and its value is the integer 8080.
- **Guess: is `port = "8080"` the same as `port = 8080` in TOML?** No. The quoted one is a string and the unquoted one is an integer. TOML values have types.

</details>

### Explanation

**TOML** (Tom's Obvious, Minimal Language) is a configuration format designed to be easy for people to read and to map cleanly onto a dictionary or hash map in code. NICo's site configuration is written in TOML. You'll meet the real site config in a later chapter. Here you learn the format itself.

A TOML file is built from three things:

1. **Key-value pairs**: `name = value`. Keys are on the left. Values are typed:
   - strings in quotes: `"lab-1"`
   - integers: `42`
   - floats: `0.5`
   - booleans: `true` or `false`
   - dates and times: `2026-11-20T10:00:00Z`
   - arrays: `["a", "b"]`
   - inline tables: `{ user = "admin", port = 443 }`
2. **Tables**: a header such as `[database]` starts a section. The keys below it belong to that table. Headers can be dotted: `[database.pool]` is a table called `pool` inside `database`. You can also write dotted keys directly: `database.pool.size = 10`.
3. **Arrays of tables**: `[[machine]]` adds a new item to a list called `machine`. Repeat the header to add another item. This is how you write a list of records, such as several expected machines.

Other rules:
- `#` starts a comment.
- Whitespace and indentation don't matter.
- Defining the same key twice is an **error**. The parser won't quietly overwrite the first value. That strictness is useful for config files.

TOML becomes a plain nested structure. In Python 3.11 and later, the standard library module `tomllib` parses it. The module can read TOML but can't write it, and you must open the file in binary mode (`'rb'`).

Why use TOML for config rather than JSON? It allows comments, it doesn't need a wall of braces, and it is stricter than YAML, so it has fewer surprises.

**Analogy.** TOML is like a filing cabinet. Each `[table]` is a labelled drawer and each `key = value` is a labelled folder inside it. `[[table]]` is a drawer of identical forms where you add one form at a time. The analogy breaks down because real folders can hold anything, while TOML values have strict types (a quoted "8080" is not the number 8080), and drawers can sit inside other drawers.

### Worked example: Parse a small TOML file and inspect what the program sees

**Step 1: Write the file.**

```bash
mkdir -p ~/ch1 && cd ~/ch1
cat > demo.toml <<'EOF'
# practice file, not a real NICo config
site_name = "lab-1"
debug = false

[database]
host = "localhost"
port = 5432

[[rack]]
name = "R01"
units = 42

[[rack]]
name = "R02"
units = 48
EOF
```

**Step 2: Parse it with Python's tomllib.**

```bash
python3 -c 'import tomllib,pprint; pprint.pprint(tomllib.load(open("demo.toml","rb")))'
```
Output:
```
{'database': {'host': 'localhost', 'port': 5432},
 'debug': False,
 'rack': [{'name': 'R01', 'units': 42}, {'name': 'R02', 'units': 48}],
 'site_name': 'lab-1'}
```

**Step 3: Check the mapping.**

`[database]` became a nested dictionary. Each `[[rack]]` became one element of the `rack` list. `5432` is an `int` and `false` is a Python `bool`.

**Step 4: Break it on purpose.**

Add a second `port = 5433` line under `[database]` and parse again. You get `tomllib.TOMLDecodeError` reporting that the key is defined more than once. The parser rejects the file instead of guessing which value you meant.

### Your turn: finish it

Fill in the blanks so the file parses to `{'bmc': [{'mac': 'B8:3F:D2:90:95:82', 'rack': 'R01'}, {'mac': '7C:C2:55:00:00:01', 'rack': 'R02'}], 'site': {'name': 'lab-1'}}`.

[site]
name = "lab-1"

___
mac = "B8:3F:D2:90:95:82"
rack = "R01"

___
mac = "7C:C2:55:00:00:01"
rack = "R02"

<details>
<summary>Answer</summary>

Both blanks are `[[bmc]]`. Each `[[bmc]]` header adds a new element to the `bmc` array of tables. Writing `[bmc]` twice would be an error, because a table can't be defined twice.

</details>

### Your turn: on your own

Convert this JSON to idiomatic TOML, then prove the two are equivalent with a one-line Python comparison:
```json
{"site": {"name": "lab-1", "tags": ["gpu", "ib"]}, "limits": {"max_hosts": 64, "dry_run": true}}
```

<details>
<summary>Hint 1</summary>

You need two tables, and one key whose value is an array.

</details>

<details>
<summary>Hint 2</summary>

The structure is `[site]` with `name` and `tags = [...]`, then `[limits]` with an integer and a boolean (lowercase `true`).

</details>

<details>
<summary>Hint 3</summary>

Check it with: `python3 -c 'import tomllib,json; print(tomllib.load(open("x.toml","rb")) == json.load(open("x.json")))'`

</details>

<details>
<summary>Answer</summary>

```toml
[site]
name = "lab-1"
tags = ["gpu", "ib"]

[limits]
max_hosts = 64
dry_run = true
```
The comparison prints `True`.

</details>

### Explain it

In your own words: Why might a team running hundreds of servers prefer a config format that errors on duplicate keys, rather than one that silently keeps the last value?

### Check

**1. What does a `[[expected_machine]]` header produce when parsed?**

A. A single nested table called expected_machine
B. A new element appended to a list called expected_machine
C. A comment
D. A table that overwrites any earlier expected_machine table

<details>
<summary>Answer</summary>

**B.** A new element appended to a list called expected_machine

Double brackets mean an array of tables, and each header adds one element. Single brackets make one table. Defining that table twice is an error, not an overwrite.

</details>

**2. In TOML, what type is `units = "42"`?**

A. Integer
B. String
C. Float
D. It depends on the parser

<details>
<summary>Answer</summary>

**B.** String

Quotes make it a string, and TOML's types are fixed by the spec, not guessed by the parser. If you want a number, leave out the quotes.

</details>

**3. Which statement about Python's `tomllib` is true?**

A. It can read and write TOML
B. It reads TOML from a file opened in binary mode
C. It needs `pip install toml`
D. It returns all values as strings

<details>
<summary>Answer</summary>

**B.** It reads TOML from a file opened in binary mode

`tomllib` is in the standard library from Python 3.11 and can only read. `tomllib.load` expects a binary file object, and it returns typed values.

</details>

**Sources:** general background knowledge; no NICo docs page covers this directly.

<a id="protocol-buffers"></a>
## 2. Protocol Buffers

### Before you read

- In the line `string guid = 2;`, what do you think the `2` means? Is it a default value?
- Guess: if a program sends a protobuf message to another program, does the receiver need the `.proto` file to decode it properly?

<details>
<summary>Answers</summary>

- **In the line `string guid = 2;`, what do you think the `2` means? Is it a default value?** It isn't a default value. It is the field number, the tag that identifies the field in the encoded binary data. Field names never appear in the binary encoding. Only the numbers do.
- **Guess: if a program sends a protobuf message to another program, does the receiver need the `.proto` file to decode it properly?** Yes, or code generated from it. The binary format contains only field numbers and values, so the receiver needs the schema to know what field 2 means.

</details>

### Explanation

**Protocol Buffers** (protobuf) does two jobs:

1. It is a **schema language**. You describe your data in a `.proto` file.
2. It is a **serialization format**, a compact binary encoding of that data.

NICo uses protobuf to define its Core APIs. The same definitions are shared with NICo REST (the glossary calls this Core Proto Synchronization), and the gRPC calls you'll meet in a later chapter are built on them.

Here is a real example from NICo's InfiniBand design doc:

```protobuf
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

The pieces:
- A **message** is a record type, like a struct.
- Each **field** has a type, a name and a **field number**. Types include `string`, integer types, `bool`, `bytes` and other messages (here `pci_properties` is itself a message).
- `sint32` is a signed 32-bit integer, encoded so that negative numbers stay small on the wire.
- `optional` lets a reader tell "not set" apart from "set to the empty default".
- `repeated` (not shown) makes a field a list.

The compiler `protoc` turns a `.proto` file into classes for Python, Go, Rust and other languages, so different languages can share one contract.

**The key rule: field numbers are the contract.** In the binary format each field is written as *number + value*, so:
- Renaming a field doesn't break binary compatibility. The doc proposes renaming `InfinibandInterface` to `InfinibandDevice`, which is safe for the binary format. The JSON mapping does use names, so a rename does matter there.
- Changing a field's number, or reusing an old number for a different meaning, breaks every existing reader. When you delete a field, mark its number `reserved`.
- Readers skip fields they don't recognise, so you can add new fields with new numbers without breaking anyone.

**Analogy.** A protobuf message is like a customs form where every box has a printed number. The shipper writes in box 2, and the receiving office knows that box 2 means "GUID" because both offices use the same form template, the `.proto` file. The analogy breaks down in one place: on a paper form you can see the labels, but in protobuf's binary format the labels are gone and only the box numbers travel.

### Worked example: Compile NICo's InfiniBand message and round-trip it in Python

**Step 1: Install the compiler and runtime.**

```bash
cd ~/ch1 && python3 -m venv .venv && . .venv/bin/activate
pip install grpcio-tools protobuf
```
`grpcio-tools` bundles `protoc`, so you can run it as `python -m grpc_tools.protoc`.

**Step 2: Write the schema.**

Save the two messages above into `ib.proto` and add `syntax = "proto3";` as the first line.

**Step 3: Generate Python code.**

```bash
python -m grpc_tools.protoc -I. --python_out=. ib.proto
ls ib_pb2.py
```

**Step 4: Build, serialize and parse a message.**

```python
import ib_pb2
from google.protobuf import json_format
m = ib_pb2.InfinibandInterface(guid="1234")
m.pci_properties.vendor = "0x15b3"
m.pci_properties.numa_node = 1
data = m.SerializeToString()
print(len(data), data)
print(ib_pb2.InfinibandInterface.FromString(data) == m)  # True
print(json_format.MessageToJson(m))
```

**Step 5: Notice what the encoding contains.**

The bytes are a few dozen at most. The strings `1234` and `0x15b3` appear, but the words `guid` and `vendor` do not. The JSON output shows `pciProperties` and `numaNode`, because protobuf's JSON mapping converts names to lowerCamelCase by default. Pass `preserving_proto_field_name=True` to keep snake_case.

### Your turn: finish it

The NICo doc proposes storing the PCI slot (for example `0000:ca:00.0`) instead of the OS-specific `path`. Add a `slot` string field to `PciDeviceProperties` without breaking existing readers.

message PciDeviceProperties {
  string vendor = 1;
  string device = 2;
  string path = 3;
  sint32 numa_node = 4;
  optional string description = 5;
  string slot = ___;
}

<details>
<summary>Answer</summary>

`string slot = 6;`. Use a new, never-used number. Old readers skip field 6. Reusing 3 (the number `path` uses) would make old readers treat the slot as a path.

</details>

### Your turn: on your own

Write a proto3 message `PcieDevice` with string fields `id`, `serial_number` and `part_number`, matching the Redfish PCIe fields NICo reads. Compile it, serialize one instance, and show that renaming `part_number` to `pn` in the `.proto` (and regenerating) still parses bytes produced before the rename.

<details>
<summary>Hint 1</summary>

Start with `syntax = "proto3";` and give the fields numbers 1 to 3.

</details>

<details>
<summary>Hint 2</summary>

Write `SerializeToString()` output to a file, rename the field, rerun `protoc`, then read the file back with `FromString`.

</details>

<details>
<summary>Hint 3</summary>

After the rename the value reads as `.pn`. It still decodes because field number 3 didn't change.

</details>

<details>
<summary>Answer</summary>

```protobuf
syntax = "proto3";
message PcieDevice {
  string id = 1;
  string serial_number = 2;
  string part_number = 3;
}
```
Bytes written before the rename decode afterwards, and the value appears under `pn`. Names are not on the binary wire, only field numbers are.

</details>

### Explain it

In your own words: Why do NICo Core and NICo REST share a single synchronized set of `.proto` files instead of each team describing the API in its own docs?

### Check

**1. You delete the field `string path = 3;`. What is the safest follow-up?**

A. Give number 3 to the next new field so there are no gaps
B. Mark 3 as `reserved` so it is never reused
C. Renumber the remaining fields so they are consecutive
D. Nothing, because numbers don't matter

<details>
<summary>Answer</summary>

**B.** Mark 3 as `reserved` so it is never reused

Old senders may still emit field 3 meaning path. Reusing or renumbering would make readers misinterpret data. Gaps in numbering are harmless.

</details>

**2. Which change breaks binary compatibility with existing clients?**

A. Renaming a field
B. Adding a new field with a new number
C. Changing an existing field's number
D. Adding a comment

<details>
<summary>Answer</summary>

**C.** Changing an existing field's number

The binary encoding identifies fields by number. Renames and comments don't touch the wire, and readers skip unknown new numbers.

</details>

**3. Why is `numa_node` declared as `sint32` rather than an unsigned type?**

A. sint32 is the only integer type in proto3
B. A NUMA node value may need to be negative (for example -1 for 'unknown'), and sint32 encodes negatives compactly
C. Unsigned types can't be serialized
D. sint32 means 'string integer'

<details>
<summary>Answer</summary>

**B.** A NUMA node value may need to be negative (for example -1 for 'unknown'), and sint32 encodes negatives compactly

Linux reports `-1` for a device's NUMA node when it has no locality information. A signed type can hold that value, and `sint32` uses zigzag encoding so negatives stay small. proto3 has many integer types, including unsigned ones.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="relational-databases-and-sql"></a>
## 3. Relational databases and SQL

### Before you read

- You have a table of machines and a table of network interfaces. How would you record which interfaces belong to which machine?
- Guess: what does `SELECT * FROM machine WHERE rack = 'R01';` return?

<details>
<summary>Answers</summary>

- **You have a table of machines and a table of network interfaces. How would you record which interfaces belong to which machine?** Give each machine a unique id (a primary key), and add a column such as `machine_id` to the interfaces table that refers to it (a foreign key).
- **Guess: what does `SELECT * FROM machine WHERE rack = 'R01';` return?** Every column of every row in the `machine` table whose `rack` column equals 'R01'.

</details>

### Explanation

A **relational database** stores data in **tables**. Each table has named, typed **columns** and any number of **rows**. You read and change the data with **SQL** (Structured Query Language).

Core ideas:
- **Primary key**: a column (or set of columns) that uniquely identifies a row, such as `id`.
- **Foreign key**: a column that points at another table's primary key, for example `interface.machine_id` pointing at `machine.id`. This is the "relation" in relational.
- **Constraints**: rules the database enforces for you, such as `UNIQUE`, `NOT NULL` and `REFERENCES`. If two machines claim the same MAC address, a `UNIQUE` constraint rejects the second insert before bad data spreads.
- **Transactions**: a group of changes that succeed or fail together (`BEGIN` ... `COMMIT`).

The common statements are `CREATE TABLE`, `INSERT`, `SELECT ... WHERE`, `UPDATE`, `DELETE`, and **`JOIN`**, which combines rows from two tables on a matching column.

Where NICo fits: during machine ingestion NICo stores discovered network interface data in its `machine` and `machine_topologies` tables. It keeps the *observed* network state on the Machine record in the database so its workflows all read from one source of truth instead of calling external services. NICo REST runs PostgreSQL, with a migration component that evolves the schema over time. You'll deploy PostgreSQL in a later chapter.

For practice you'll use **SQLite**. It is a full SQL database in a single file and is built into Python's standard library, so there's nothing to install. Most of the SQL you write here runs unchanged on PostgreSQL.

**Analogy.** A relational database is a set of spreadsheets that know how to cross-reference each other. Each sheet is a table, and a `machine_id` column works like a hyperlink to a row on another sheet. The analogy breaks down because a spreadsheet lets you type anything anywhere, while a database enforces types and constraints and can roll back a half-finished change.

### Worked example: Model machines and their interfaces in SQLite

**Step 1: Create the schema.**

```python
# db.py
import sqlite3
db = sqlite3.connect("lab.db")
db.execute("PRAGMA foreign_keys = ON")
db.executescript("""
DROP TABLE IF EXISTS interface; DROP TABLE IF EXISTS machine;
CREATE TABLE machine (id INTEGER PRIMARY KEY, serial TEXT UNIQUE NOT NULL, rack TEXT);
CREATE TABLE interface (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machine(id),
  mac TEXT UNIQUE NOT NULL);
""")
```

**Step 2: Insert rows.**

```python
db.execute("INSERT INTO machine (id, serial, rack) VALUES (1,'J1234XY','R01'),(2,'K9999ZZ','R02')")
db.execute("INSERT INTO interface (machine_id, mac) VALUES (1,'B8:3F:D2:90:95:82'),(1,'B8:3F:D2:90:95:83')")
db.commit()
```

**Step 3: Join the tables.**

```python
for row in db.execute("""
  SELECT m.serial, m.rack, i.mac FROM machine m
  JOIN interface i ON i.machine_id = m.id ORDER BY i.mac"""):
    print(row)
```
This prints two rows for `J1234XY`. `K9999ZZ` has no interfaces, so an inner `JOIN` leaves it out.

**Step 4: Watch a constraint protect you.**

```python
db.execute("INSERT INTO interface (machine_id, mac) VALUES (2,'B8:3F:D2:90:95:82')")
```
This raises `sqlite3.IntegrityError: UNIQUE constraint failed: interface.mac`. The database refuses to let two machines claim one MAC.

### Your turn: finish it

Count the interfaces each machine has, including machines with zero interfaces.

SELECT m.serial, COUNT(i.id) AS n
FROM machine m
___ interface i ON i.machine_id = m.id
___ m.serial;

<details>
<summary>Answer</summary>

`LEFT JOIN` and `GROUP BY`. `LEFT JOIN` keeps machines with no matching interfaces, and `COUNT(i.id)` counts 0 for them. `GROUP BY m.serial` produces one row per machine: J1234XY 2, K9999ZZ 0.

</details>

### Your turn: on your own

Write one SQL query that lists the serial of every machine that has no interfaces at all. Run it against `lab.db`.

<details>
<summary>Hint 1</summary>

You need every machine row, whether or not it has a match, so think about which JOIN keeps unmatched rows.

</details>

<details>
<summary>Hint 2</summary>

After a LEFT JOIN, the interface columns are NULL for machines with no match.

</details>

<details>
<summary>Hint 3</summary>

`... LEFT JOIN interface i ON i.machine_id = m.id WHERE i.id IS NULL`

</details>

<details>
<summary>Answer</summary>

```sql
SELECT m.serial FROM machine m
LEFT JOIN interface i ON i.machine_id = m.id
WHERE i.id IS NULL;
```
Returns `K9999ZZ`.

</details>

### Explain it

In your own words: NICo caches observed network state in its database and has its workflows read that copy instead of querying external services directly. In your own words, why does that make the workflows more deterministic?

### Check

**1. What does a foreign key do?**

A. Encrypts a column
B. Makes a column refer to a primary key in another table, so the database can enforce the link
C. Makes a column unique
D. Speeds up every query automatically

<details>
<summary>Answer</summary>

**B.** Makes a column refer to a primary key in another table, so the database can enforce the link

Uniqueness is a separate `UNIQUE` constraint. Indexes, not foreign keys, are what speed up lookups, and a foreign key has nothing to do with encryption.

</details>

**2. An inner JOIN between machine and interface returns which machines?**

A. All machines
B. Only machines with at least one matching interface
C. Only machines without interfaces
D. Only the first machine

<details>
<summary>Answer</summary>

**B.** Only machines with at least one matching interface

An inner JOIN keeps only rows that match on both sides. To keep unmatched machines, use LEFT JOIN.

</details>

**3. Why put a UNIQUE constraint on `interface.mac` instead of checking for duplicates in application code?**

A. SQL can't check duplicates any other way
B. The database enforces it for every writer, even under concurrent inserts
C. It makes the column hold numbers
D. UNIQUE also creates a foreign key

<details>
<summary>Answer</summary>

**B.** The database enforces it for every writer, even under concurrent inserts

A check in application code can race with another writer, or be skipped by a different program. A constraint in the database applies to every write.

</details>

**Sources:** [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="yaml"></a>
## 4. YAML

### Before you read

- In YAML, what is the difference between `- web` and `web:`?
- Guess: what does the YAML `country: no` turn into when loaded by Python's PyYAML?

<details>
<summary>Answers</summary>

- **In YAML, what is the difference between `- web` and `web:`?** `- web` is an item in a list (a sequence). `web:` is a key in a mapping, and its value follows on the same line or indented below.
- **Guess: what does the YAML `country: no` turn into when loaded by Python's PyYAML?** `{'country': False}`. YAML 1.1 parsers like PyYAML treat `no` as a boolean. This is the famous "Norway problem".

</details>

### Explanation

**YAML** is a human-readable data format where **indentation shows structure**. It's the language of Kubernetes manifests and Helm values files. NICo Core and NICo REST are both deployed through Helm charts, which you'll use in a later chapter.

The three building blocks:
- **Mappings** (key-value pairs): `name: lab-1`. Indent child keys under a parent:
  ```yaml
  database:
    host: localhost
    port: 5432
  ```
- **Sequences** (lists): one `- item` per line, or `[a, b]` inline.
- **Scalars**: strings, numbers, booleans and null (`null` or `~`).

Rules and features:
- Indent with **spaces only**. Tabs are illegal. Siblings must line up exactly.
- `#` starts a comment.
- `|` keeps a multi-line string's line breaks, and `>` folds the lines into one.
- `---` separates multiple documents in one file. Kubernetes uses this constantly.
- JSON is, for practical purposes, valid YAML.

**The big trap is implicit typing.** YAML guesses a type for unquoted values:
- `no`, `off` and `yes` may become booleans.
- `1.10` becomes the float `1.1`, so a version number gets mangled.
- `0123` may become an octal number.
- With YAML 1.1 parsers such as PyYAML, colon-separated digits like `12:30` can become a base-60 number.
- An unquoted `guid: 1234` is an integer, not a string.

The fix is simple: **quote anything that must stay a string**, such as IDs, versions, MAC addresses and PCI addresses.

Compared with TOML, YAML is more compact for deeply nested data but more forgiving, and that forgiveness is exactly what lets silent mistakes through.

**Analogy.** YAML is like an outline in a word processor: indentation shows what belongs under what. The analogy breaks down because a word processor never changes your text, while YAML quietly turns `no` into false and `1.10` into 1.1 unless you quote them.

### Worked example: Load YAML and catch the implicit-typing traps

**Step 1: Install a parser.**

```bash
pip install pyyaml
```

**Step 2: Write a values file.**

```bash
cat > values.yaml <<'EOF'
image:
  tag: 1.10
replicas: 3
region: no
guid: 1234
slot: 0000:00:01.0
hosts:
  - name: alpha
    mac: "b8:3f:d2:90:95:82"
  - name: beta
    mac: "b8:3f:d2:90:95:83"
EOF
```

**Step 3: Load it.**

```bash
python3 -c 'import yaml,pprint; pprint.pprint(yaml.safe_load(open("values.yaml")))'
```

**Step 4: Read the result critically.**

- `tag` is `1.1` (a float).
- `region` is `False`.
- `guid` is the int `1234`.
- `slot` is not the string you wrote. PyYAML reads the colon-separated digits as a base-60 number.
- `hosts` is a list of two dicts.

None of these surprises produce an error. Quote them all (`tag: "1.10"`, `region: "no"`, `guid: "1234"`, `slot: "0000:00:01.0"`) and reload: every one is now a string.

### Your turn: finish it

Complete this YAML so it loads as `{'racks': [{'name': 'R01', 'units': 42}, {'name': 'R02', 'units': 48}]}`.

racks:
  ___ name: R01
    units: 42
  - name: R02
  ___units: 48

<details>
<summary>Answer</summary>

The first blank is `- ` (a dash and a space, starting a list item). The second blank is two spaces, so `units` lines up under `name` (four spaces in total). Sibling keys of a list item must align with the first key after the dash.

</details>

### Your turn: on your own

This file fails to load. Find both problems, fix them, and make sure `version` loads as the string "2.10".
```yaml
service:
  name: api
	port: 8080
  version: 2.10
```

<details>
<summary>Hint 1</summary>

Read the error message: it names the line and column.

</details>

<details>
<summary>Hint 2</summary>

One line is indented with a tab character, which YAML forbids.

</details>

<details>
<summary>Hint 3</summary>

Replace the tab with two spaces, and quote the version.

</details>

<details>
<summary>Answer</summary>

```yaml
service:
  name: api
  port: 8080
  version: "2.10"
```

</details>

### Explain it

In your own words: Why is it good practice to quote MAC addresses, GUIDs and version numbers in YAML even when they happen to load correctly today?

### Check

**1. What does PyYAML produce for `tag: 1.10`?**

A. The string "1.10"
B. The float 1.1
C. An error
D. The integer 110

<details>
<summary>Answer</summary>

**B.** The float 1.1

Unquoted, `1.10` matches the float pattern, and the trailing zero is lost. Quote it to keep it a string.

</details>

**2. Which is legal YAML indentation?**

A. Tabs only
B. Spaces only
C. A mix of tabs and spaces
D. Any whitespace, since indentation is decorative

<details>
<summary>Answer</summary>

**B.** Spaces only

YAML forbids tabs for indentation, and the indentation is the structure, not decoration.

</details>

**3. What does `---` mean in a YAML file?**

A. A comment
B. The start of a new document in the same file
C. An empty list
D. A horizontal rule with no meaning

<details>
<summary>Answer</summary>

**B.** The start of a new document in the same file

Kubernetes and Helm output often put several manifests in one file separated by `---`. Comments start with `#`.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="mac-address"></a>
## 5. MAC address

### Before you read

- How many bits is a standard Ethernet MAC address, and how is it usually written?
- Are `b8-3f-d2-90-95-82` and `B83FD2909582` the same MAC address?

<details>
<summary>Answers</summary>

- **How many bits is a standard Ethernet MAC address, and how is it usually written?** 48 bits, written as six two-digit hex bytes, for example `B8:3F:D2:90:95:82`.
- **Are `b8-3f-d2-90-95-82` and `B83FD2909582` the same MAC address?** Yes. Only the separators and letter case differ. Code that compares raw strings would wrongly call them different.

</details>

### Explanation

A **MAC address** (Media Access Control address) is the hardware address of a network interface. Every Ethernet port has one: on your laptop, on a server's NIC, on a DPU and on a BMC.

Facts to know:
- It is **48 bits**, written as 6 hex bytes. Formats vary: `B8:3F:D2:90:95:82`, `b8-3f-d2-90-95-82`, `b83f.d290.9582`, or `B83FD2909582`. Case doesn't matter.
- The first 3 bytes are usually the **OUI**, a prefix assigned to the manufacturer.
- In the first byte, bit 0 (value 1) set means **multicast**. Bit 1 (value 2) set means **locally administered**: software chose the address rather than the factory. Docker's `02:42:...` addresses are an example.
- MACs work at layer 2, on the local link. An **IP address** is a different thing: it is assigned by configuration (often DHCP) and is routable.

**Why NICo cares.** A MAC is stable hardware identity that is visible before any OS is installed, so NICo uses it as a key in several places:
- **BMC discovery:** when a BMC requests an IP over DHCP, NICo cross-references its MAC against the expected machine table to look up initial credentials.
- **Redfish:** the BMC's `MACAddress` (under `Managers/{id}/EthernetInterfaces`) is *Critical* for BMC identification and credential storage and lookup. The system NIC `MACAddress` is *Critical* for DPU-host pairing. NICo accepts both `MACAddress` and `MacAddress` spellings, because vendors differ.
- **Boot options:** NICo extracts a MAC from a UEFI device path such as `.../MAC(B83FD2909582,0x1)` and reformats `B83FD2909582` as `B8:3F:D2:90:95:82`.
- **Switches:** a switch that declares a MAC already owned by another switch enters the `Error` state.

The lesson: **normalise MACs to a single canonical form before you compare or store them.**

**Analogy.** A MAC address is like a car's VIN: it is stamped at the factory and identifies the hardware no matter where it is parked. An IP address is more like a parking-space number. The analogy breaks down because a MAC can be changed in software (locally administered addresses), while a VIN legally can't.

### Worked example: Find, normalise and extract MAC addresses

**Step 1: List your own MACs.**

Linux: `ip -br link` (the third column is the MAC). macOS: `ifconfig | grep ether`.

**Step 2: Write a normaliser.**

```python
import re
def norm_mac(s: str) -> str:
    h = re.sub(r'[^0-9a-fA-F]', '', s).upper()
    if len(h) != 12:
        raise ValueError(f'not a MAC: {s!r}')
    return ':'.join(h[i:i+2] for i in range(0, 12, 2))

for s in ['b8-3f-d2-90-95-82', 'b83f.d290.9582', 'B83FD2909582']:
    print(norm_mac(s))   # all B8:3F:D2:90:95:82
```

**Step 3: Pull a MAC out of a UEFI device path.**

Using the Redfish BootOption sample from NICo's docs:
```python
path = 'PciRoot(0x2)/Pci(0x1,0x0)/Pci(0x0,0x0)/MAC(B83FD2909582,0x1)'
m = re.search(r'MAC\(([0-9A-Fa-f]+),', path)
print(norm_mac(m.group(1)))  # B8:3F:D2:90:95:82
```

**Step 4: Read the special bits.**

```python
first = int('B8', 16)          # 0b10111000
print(bool(first & 1), bool(first & 2))  # False False: unicast, universal
```

### Your turn: finish it

Complete the dictionary lookup so BMC credentials are found no matter how the MAC was formatted.

creds = {norm_mac('B8:3F:D2:90:95:82'): ('admin', 'secret')}

def lookup(mac_from_dhcp):
    return creds.get(___)

print(lookup('b8-3f-d2-90-95-82'))

<details>
<summary>Answer</summary>

`norm_mac(mac_from_dhcp)`. Normalise on both sides, when you store and when you look up. That way `('admin', 'secret')` is found whatever format arrives.

</details>

### Your turn: on your own

For each MAC, say whether it is unicast or multicast and universal or locally administered: `02:42:ac:11:00:02`, `B8:3F:D2:90:95:82`, `01:00:5e:00:00:fb`.

<details>
<summary>Hint 1</summary>

Look only at the first byte.

</details>

<details>
<summary>Hint 2</summary>

Bit value 1 is the multicast flag and bit value 2 is the locally-administered flag.

</details>

<details>
<summary>Hint 3</summary>

0x02 = 0b00000010, 0xB8 = 0b10111000, 0x01 = 0b00000001.

</details>

<details>
<summary>Answer</summary>

`02:42:...` is unicast and locally administered (a Docker-generated address). `B8:3F:...` is unicast and universal (factory-assigned). `01:00:5e:...` is multicast and universal (an IPv4 multicast MAC).

</details>

### Explain it

In your own words: NICo looks up a BMC's initial credentials by MAC address rather than by IP address. Why is the MAC the better key at the moment a brand-new BMC first appears on the network?

### Check

**1. Which Redfish field does NICo treat as Critical for BMC identification and credential lookup?**

A. Managers/{id} FirmwareVersion
B. Managers/{id}/EthernetInterfaces/{id} MACAddress
C. Systems/{id} PowerState
D. Chassis/{id} Model

<details>
<summary>Answer</summary>

**B.** Managers/{id}/EthernetInterfaces/{id} MACAddress

The endpoints reference marks the BMC's MACAddress as Critical for identification and credential storage. FirmwareVersion and PowerState are Required, used for tracking and health, not identity. Model is only Recommended.

</details>

**2. Your code compares `b8:3f:d2:90:95:82` with `B8-3F-D2-90-95-82` using `==` and gets False. What is the right fix?**

A. Lowercase one side only
B. Normalise both to one canonical form before comparing
C. Compare only the first 3 bytes
D. Use the IP address instead

<details>
<summary>Answer</summary>

**B.** Normalise both to one canonical form before comparing

Case and separators both differ, so you need full normalisation on both sides. Comparing only the OUI matches every device from the same vendor.

</details>

**3. Which statement is true?**

A. A MAC address is routable across the internet
B. A MAC address can never be changed
C. A locally administered MAC has bit value 2 set in its first byte
D. MACs are 32 bits long

<details>
<summary>Answer</summary>

**C.** A locally administered MAC has bit value 2 set in its first byte

MACs are 48-bit, link-local identifiers. They can be overridden in software, and the locally-administered bit signals that.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md)

<a id="pcie-device"></a>
## 6. PCIe device

### Before you read

- Name three kinds of hardware you'd expect to be plugged into a server's PCIe slots.
- Guess: if a dual-port network card is plugged into one slot, does the OS see one PCIe device or two?

<details>
<summary>Answers</summary>

- **Name three kinds of hardware you'd expect to be plugged into a server's PCIe slots.** Network cards (NICs), DPUs, GPUs, NVMe SSDs and storage controllers are all typical.
- **Guess: if a dual-port network card is plugged into one slot, does the OS see one PCIe device or two?** Often two: one PCI function per port, such as `ca:00.0` and `ca:00.1`. They share a serial number.

</details>

### Explanation

**PCI Express (PCIe)** is the high-speed bus that connects a server's CPUs to add-in hardware. It is made of point-to-point **lanes** (x1, x4, x8, x16), and more lanes means more bandwidth. A **PCIe device** is anything attached this way: NICs, DPUs (such as NVIDIA BlueField), GPUs, NVMe drives. Devices can sit in physical slots or be soldered onto the motherboard.

Every PCIe device reports identity registers:
- **Vendor ID** and **device ID**, for example `0x15b3` (Mellanox) and `0x101b` (ConnectX-6), as they appear in NICo's discovery data.
- A class (network controller, InfiniBand controller, and so on).

One physical card can expose several **functions**, each appearing as its own PCI device. NICo's InfiniBand design relies on this: each port of a dual-port ConnectX-6 shows up as a separate device. Both ports report the same serial number, though.

On Linux:
- `lspci` lists devices.
- `lspci -nn` adds the numeric IDs.
- `/sys/bus/pci/devices/` exposes each device as files.

On macOS, `system_profiler SPPCIDataType` shows similar information.

**How NICo uses PCIe devices.** The host's BMC exposes PCIe devices through Redfish. On most vendors they're linked from `Systems/{id}`. Supermicro lists them under `Chassis/{id}/PCIeDevices` instead. Two fields are marked **Critical**:
- `SerialNumber`: the **primary DPU-host pairing path**. NICo matches a PCIe device's serial seen by the host BMC against the DPU's own system serial number, and that match proves the DPU is installed in that host. A network adapter `SerialNumber` is the fallback path.
- `PartNumber`: used to recognise BlueField models (BF2, BF3, BF3 SuperNIC).

The endpoints reference notes that NICo trims whitespace from Chassis and network adapter serials. Trimming defensively before comparing any serial is good practice in your own code too.

**Analogy.** PCIe is like the sockets on a power strip that is wired straight to the CPU. Each plugged-in device has a label (its vendor and device ID) that the host can read. The analogy breaks down because one plug can present itself as several separate devices (functions), and lanes carry data at different widths rather than just power.

### Worked example: Inspect PCIe devices locally and pair a DPU from Redfish data

**Step 1: List devices with IDs.**

Linux: `lspci -nn | head`. A line like `00:02.0 VGA compatible controller [0300]: Intel ... [8086:46a6]` shows the class `[0300]`, the vendor `8086` (Intel) and the device ID `46a6`.

(In a VM or container you may see virtual devices. That's fine.)

**Step 2: Read the same data from sysfs.**

```bash
d=$(ls /sys/bus/pci/devices | head -1)
cat /sys/bus/pci/devices/$d/vendor /sys/bus/pci/devices/$d/device
```

**Step 3: Mock the Redfish views.**

Imagine what the **host** BMC reports. This mock adds stray spaces around the serial on purpose, to show why defensive trimming helps:
```json
{"Id": "236-0", "SerialNumber": " MT2243X01234 ", "PartNumber": "900-9D3B6-00CV-AA0"}
```
and what the **DPU's** BMC reports for its own system serial: `MT2243X01234`.

**Step 4: Pair them by serial, trimming defensively.**

```python
host_pcie = [{"Id": "236-0", "SerialNumber": " MT2243X01234 "}]
dpu_serials = {"MT2243X01234": "dpu-A"}
for dev in host_pcie:
    s = dev["SerialNumber"].strip()
    if s in dpu_serials:
        print(f"host PCIe {dev['Id']} is {dpu_serials[s]}")
```
The serial match follows the pairing path NICo describes. The `.strip()` is your own defensive step: without it, this mock data wouldn't match.

### Your turn: finish it

Only BlueField cards should be considered for pairing. Complete the filter using the part number prefix `900-9D3B6` from the docs' Chassis sample. Treat the prefix as illustrative: NICo's real `is_bluefield_model()` logic covers more cases.

def candidates(devs):
    return [d for d in devs
            if d.get('PartNumber', '').strip().upper().startswith(___)]

<details>
<summary>Answer</summary>

`'900-9D3B6'`. The filter keeps devices whose cleaned part number starts with the BlueField prefix. Normalise case and whitespace first, just as you did for serials.

</details>

### Your turn: on your own

Host BMC PCIe list: `[{Id:'a', SerialNumber:'MT001'}, {Id:'b', SerialNumber:'MT002 '}, {Id:'c', SerialNumber:'GPU77'}]`. DPU system serials: `dpu-1 → 'MT002'`, `dpu-2 → 'MT009'`. Which DPUs pair with this host, and which do not?

<details>
<summary>Hint 1</summary>

Pairing means the host sees a PCIe device whose serial equals the DPU's serial.

</details>

<details>
<summary>Hint 2</summary>

Trim whitespace before comparing.

</details>

<details>
<summary>Hint 3</summary>

MT002 (device b) matches dpu-1. Nothing in the host's list equals MT009.

</details>

<details>
<summary>Answer</summary>

dpu-1 pairs with this host through PCIe device `b`, once its trailing space is trimmed. dpu-2 doesn't pair: it's in some other host, or the host BMC can't see it.

</details>

### Explain it

In your own words: NICo pairs a DPU with a host by matching a serial number seen from two different BMCs. Why does matching from two independent viewpoints give stronger evidence than trusting either BMC alone?

### Check

**1. Which Redfish PCIe device field is NICo's primary DPU-host pairing key?**

A. Id
B. SerialNumber
C. Model
D. FirmwareVersion

<details>
<summary>Answer</summary>

**B.** SerialNumber

The endpoints reference marks PCIe SerialNumber as Critical and the primary pairing path. Id is used only for tracking. PartNumber, also Critical, identifies BlueField models but doesn't pair anything.

</details>

**2. On a Supermicro host, where does NICo find PCIe devices?**

A. Systems/{id} PCIeDevices array
B. Chassis/{id}/PCIeDevices
C. Managers/{id}/PCIeDevices
D. UpdateService/FirmwareInventory

<details>
<summary>Answer</summary>

**B.** Chassis/{id}/PCIeDevices

Supermicro uses the chassis path. Other vendors embed PCIeDevices links in the Systems/{id} response.

</details>

**3. A dual-port ConnectX-6 appears as `ca:00.0` and `ca:00.1`. What do the two have in common?**

A. Nothing, they are different cards
B. The same serial number
C. Different vendor IDs
D. Different PCI bus numbers

<details>
<summary>Answer</summary>

**B.** The same serial number

They are two functions of one card, on the same bus and device number, with the same vendor ID. NICo's doc notes that both report the same serial.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="numa-node"></a>
## 7. NUMA node

### Before you read

- In a server with two CPU sockets, can every core reach every byte of memory equally fast?
- Guess: does a NIC or GPU "belong" to a particular CPU socket?

<details>
<summary>Answers</summary>

- **In a server with two CPU sockets, can every core reach every byte of memory equally fast?** No. Each socket has its own memory. Reaching the other socket's memory goes over an interconnect and is slower. That is non-uniform memory access.
- **Guess: does a NIC or GPU "belong" to a particular CPU socket?** Yes. Each PCIe device hangs off one socket's PCIe lanes, so it is local to that socket's NUMA node.

</details>

### Explanation

**NUMA** stands for Non-Uniform Memory Access. In a multi-socket server, each CPU socket has its own memory controllers and its own PCIe lanes. A **NUMA node** is one of these locality domains: a group of CPU cores, the memory attached to them, and the devices wired to them.

Accessing something on your own node is **local** and fast. Accessing another node's memory or devices is **remote**: the traffic crosses the inter-socket link, which adds latency and competes for bandwidth.

This matters a lot for GPU servers. When a GPU sends data straight to an InfiniBand NIC (as RDMA traffic does), it's best if both sit on the **same NUMA node**. Otherwise every packet takes the long way across the socket interconnect.

On Linux:
- `lscpu | grep -i numa` shows the node count and which CPUs belong to each node.
- `numactl --hardware` shows memory per node and the relative "distances" between nodes.
- `cat /sys/bus/pci/devices/<addr>/numa_node` gives a device's node. `-1` means the kernel has no locality information, which is common on laptops and VMs, where there's effectively a single node.

**In NICo:** the hardware discovery message `PciDeviceProperties` includes a `numa_node` field (`sint32`). In the doc's example, both ConnectX-6 ports are on `numa_node: 1`. NICo's designers discussed letting tenants select InfiniBand devices by NUMA node and decided against it, because it would add yet another API selector. Instead, the mapping from selection to hardware is identical across all machines of one instance type. A tenant can therefore test on one instance, find the device choice with good GPU locality, and reuse that exact configuration everywhere.

**Analogy.** A two-socket server is like a two-building office with a footbridge. Your desk, your filing cabinet and your printer are fastest if they're all in your building. You can use a printer in the other building, but every trip crosses the bridge. The analogy breaks down because the footbridge in a server is still extremely fast in human terms. The cost shows up only at high data rates, which is exactly where GPUs and InfiniBand operate.

### Worked example: Discover NUMA layout and device locality

**Step 1: Count NUMA nodes.**

```bash
lscpu | grep -i numa
```
A laptop typically shows `NUMA node(s): 1`. A two-socket server shows 2 or more.

**Step 2: Check memory per node (optional).**

```bash
numactl --hardware   # install with: sudo apt install numactl
```

**Step 3: Read each PCI device's node.**

```bash
for d in /sys/bus/pci/devices/*; do
  echo "$(basename $d) numa=$(cat $d/numa_node)"
done | head
```
On a laptop expect `-1` or `0` everywhere. On a GPU server you'd see some devices on 0 and some on 1.

**Step 4: Interpret NICo's discovery data.**

In the doc's ConnectX-6 example both ports report `"numa_node": 1`. A GPU also on node 1 is local to them, and a GPU on node 0 is remote.

### Your turn: finish it

Group discovered devices by NUMA node so you can see which NICs are local to which GPUs.

from collections import defaultdict
devs = [('gpu0','0000:17:00.0',0), ('ib0','0000:ca:00.0',1), ('gpu1','0000:e9:00.0',1)]
by_node = defaultdict(list)
for name, slot, node in devs:
    by_node[___].append(name)
print(dict(by_node))

<details>
<summary>Answer</summary>

`node`. The output is `{0: ['gpu0'], 1: ['ib0', 'gpu1']}`, so ib0 is local to gpu1 and remote from gpu0.

</details>

### Your turn: on your own

Your training job pins a GPU on NUMA node 1. The InfiniBand devices are: `0000:cb:00.0` (node 0), `0000:cd:00.0` (node 0), `0000:ea:00.0` (node 1), `0000:eb:00.0` (node 1). Which devices give local access, and how would a NICo tenant lock this choice in across many machines?

<details>
<summary>Hint 1</summary>

Local means the same NUMA node as the GPU.

</details>

<details>
<summary>Hint 2</summary>

Two devices are on node 1.

</details>

<details>
<summary>Hint 3</summary>

NICo doesn't offer a NUMA selector. Remember the test-instance approach and why it works.

</details>

<details>
<summary>Answer</summary>

`0000:ea:00.0` and `0000:eb:00.0` are local. The tenant creates a test instance, finds which device selection lands on those slots, and reuses that configuration. Because NICo maps selections to hardware identically for every machine of the instance type, the choice carries over.

</details>

### Explain it

In your own words: Why would putting a GPU and its InfiniBand NIC on different NUMA nodes hurt performance even though the server still works correctly?

### Check

**1. What is a NUMA node?**

A. A Kubernetes worker node
B. A CPU-and-memory locality domain, with the devices attached to it
C. A single CPU core
D. A network switch port

<details>
<summary>Answer</summary>

**B.** A CPU-and-memory locality domain, with the devices attached to it

Despite the word "node", it isn't a separate machine. It's a group of cores, memory and PCIe lanes within one server.

</details>

**2. `cat /sys/bus/pci/devices/0000:00:02.0/numa_node` prints `-1`. What does that most likely mean?**

A. The device is broken
B. The kernel has no NUMA locality info for it, typical on single-node machines
C. It's on the last NUMA node
D. The device is remote from every CPU

<details>
<summary>Answer</summary>

**B.** The kernel has no NUMA locality info for it, typical on single-node machines

`-1` is Linux's "unknown or not applicable" value. It's common on laptops and VMs.

</details>

**3. How does NICo's InfiniBand design let tenants get good GPU-NIC locality without a NUMA selector in the API?**

A. NICo always places NICs on node 0
B. Device mapping is the same across an instance type, so a configuration found on one test instance carries over
C. Tenants edit the NUMA field directly
D. NICo hides NUMA entirely from discovery

<details>
<summary>Answer</summary>

**B.** Device mapping is the same across an instance type, so a configuration found on one test instance carries over

The doc describes exactly this approach. Discovery data does include `numa_node`, so it isn't hidden, and tenants can't edit it.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="cpu-architectures"></a>
## 8. CPU architectures (amd64 vs arm64)

### Before you read

- You compile a Go program natively on an Apple Silicon Mac and copy the binary to an Intel Linux server. Will it run?
- Are `x86_64` and `amd64` different architectures?

<details>
<summary>Answers</summary>

- **You compile a Go program natively on an Apple Silicon Mac and copy the binary to an Intel Linux server. Will it run?** No, for two reasons: the binary is for a different OS (macOS rather than Linux) and a different CPU architecture (arm64 rather than amd64).
- **Are `x86_64` and `amd64` different architectures?** No. They are two names for the same 64-bit x86 instruction set. Likewise `aarch64` and `arm64` mean the same thing.

</details>

### Explanation

A CPU **architecture**, or **instruction set architecture (ISA)**, is the set of machine instructions a processor understands. Compiled programs are just bytes of those instructions, so **a binary built for one ISA can't run natively on another**.

Two architectures dominate servers today:
- **amd64**, also written x86_64, x86-64 or x64: Intel and AMD processors.
- **arm64**, also written aarch64 or ARMv8-A 64-bit: Apple Silicon, AWS Graviton, NVIDIA Grace, and the Arm cores on BlueField DPUs.

Different tools print different names for the same thing:
- `uname -m` prints `x86_64` or `aarch64` on Linux, and `arm64` on macOS.
- Docker uses `linux/amd64` and `linux/arm64`.
- Debian packages use `amd64` and `arm64`.

What runs where:
- **Compiled binaries** (C, Go, Rust) are tied to one architecture and one OS. macOS is a partial exception: it can ship **universal ("fat") binaries** that bundle an x86_64 build and an arm64 build in one file, and the OS picks the matching one. Linux has no equivalent; you ship one binary per architecture.
- **Interpreted code** (Python, shell) is portable, *but* any compiled extension it uses (a Python wheel with C code, for example) is not.
- **Container images** are per architecture. A "multi-arch" image is really an index pointing at one image per architecture. Run the wrong one and you see `exec format error`.
- **Emulation** (QEMU with Linux binfmt) can run foreign binaries slowly. That is a later chapter.

**Why NICo cares:** a ManagedHost mixes architectures. The Host is typically an x86 machine, while the BlueField DPU attached to it has its own Arm processor and its own operating system. Anything that runs on the DPU (agents, containers, images) must be built for arm64, even when the host and the control plane are amd64.

**Analogy.** An ISA is like a language. A binary is a book written in French, and an amd64 CPU only reads English. A translator (an emulator) can read it aloud, but slowly. The analogy breaks down because human languages overlap and you can sometimes guess the meaning, while a CPU given the wrong instruction set simply refuses to start the program.

### Worked example: Identify architectures and see a mismatch

**Step 1: Check your machine.**

```bash
uname -m          # x86_64, aarch64, or arm64 (macOS)
file /bin/ls
```
On Linux, `file` prints something like `ELF 64-bit LSB pie executable, x86-64, ...` (or `ARM aarch64` on an Arm machine). On macOS, `/bin/ls` is a universal binary, so you see something like:
```
/bin/ls: Mach-O universal binary with 2 architectures: [x86_64:...] [arm64e:...]
```
That's one file carrying two builds. `arm64e` is Apple's variant of arm64 with pointer authentication.

**Step 2: Inspect a container image's architecture.**

```bash
docker pull alpine:3.20
docker image inspect alpine:3.20 --format '{{.Os}}/{{.Architecture}}'
```
Docker pulled the variant that matches your host.

**Step 3: Request the other architecture.**

```bash
docker run --rm --platform linux/arm64 alpine:3.20 uname -m   # on an amd64 host
```
If emulation is set up (Docker Desktop includes it), this prints `aarch64`. Otherwise you get `exec format error`, which is proof the binary is foreign to your CPU.

**Step 4: Map back to NICo.**

That `aarch64` is what software running on a BlueField DPU's Arm cores would report. A host-side tool would report `x86_64`.

### Your turn: finish it

Map `uname -m` output to a Docker platform string.

def docker_platform(uname_m):
    return {
        'x86_64': 'linux/amd64',
        'aarch64': ___,
        'arm64': 'linux/arm64',
    }[uname_m]

<details>
<summary>Answer</summary>

`'linux/arm64'`. `aarch64` (Linux) and `arm64` (macOS) name the same ISA.

</details>

### Your turn: on your own

You're shipping (a) a Go CLI that operators run on amd64 Linux workstations and on M-series Macs, and (b) an agent container that runs on BlueField DPUs. List the OS/arch targets each artifact needs.

<details>
<summary>Hint 1</summary>

Each artifact needs one build per OS and architecture combination it runs on.

</details>

<details>
<summary>Hint 2</summary>

Macs run darwin and the workstations run linux. The DPU's processor is Arm.

</details>

<details>
<summary>Hint 3</summary>

Go uses GOOS/GOARCH, for example GOOS=darwin GOARCH=arm64.

</details>

<details>
<summary>Answer</summary>

(a) `linux/amd64` and `darwin/arm64`, two binaries. (b) `linux/arm64` for the DPU. You can also publish a multi-arch image if the agent ever needs to run on amd64.

</details>

### Explain it

In your own words: Why does a Python script usually run on both amd64 and arm64, while a `pip`-installed package can still fail with an architecture error?

### Check

**1. Which pair names the same architecture?**

A. amd64 and arm64
B. x86_64 and amd64
C. aarch64 and x86_64
D. arm64 and i386

<details>
<summary>Answer</summary>

**B.** x86_64 and amd64

The names look similar but amd64 and arm64 are different ISAs. x86_64 and amd64 are the same, and so are aarch64 and arm64.

</details>

**2. Running a container prints `exec format error`. Most likely cause?**

A. The image is corrupted
B. The image's binaries are for a different CPU architecture than the host
C. Missing network access
D. Wrong file permissions

<details>
<summary>Answer</summary>

**B.** The image's binaries are for a different CPU architecture than the host

That message is the kernel refusing a binary for a foreign ISA, with no emulator set up to run it.

</details>

**3. In a NICo ManagedHost, which component needs arm64 software?**

A. The x86 Host
B. The BlueField DPU
C. Neither; everything is amd64
D. Only the BMC web UI

<details>
<summary>Answer</summary>

**B.** The BlueField DPU

The glossary describes the DPU as having its own Arm processor and OS. The Host is typically x86.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="server-hardware-basics"></a>
## 9. Server hardware basics

### Before you read

- Guess: what is a BMC, and why might a server have one even when it has no operating system installed?
- What does "1U" mean when describing a server?

<details>
<summary>Answers</summary>

- **Guess: what is a BMC, and why might a server have one even when it has no operating system installed?** A Baseboard Management Controller is a small, separate computer on the server's board, with its own network port. It can power the server on and off, read sensors, and change firmware settings without any host OS, which is how NICo manages machines remotely.
- **What does "1U" mean when describing a server?** One rack unit, 1.75 inches (44.45 mm) of vertical space in a standard 19-inch rack.

</details>

### Explanation

A rack server is a computer built for density, remote management and uptime. Its parts:
- **CPUs**: one or more sockets, each with many cores.
- **Memory**: DIMMs attached to each socket (this is where NUMA comes from).
- **Drives**: NVMe SSDs on PCIe, or SATA/SAS drives behind a controller.
- **NICs**, plus GPUs and DPUs, on PCIe.
- **Redundant power supplies** and fans.
- **Firmware** everywhere: the system BIOS/UEFI that boots the machine, plus separate firmware on the BMC, on NICs and DPUs, and on other components.

The defining extra is the **BMC (Baseboard Management Controller)**, a tiny independent computer on the motherboard. It runs whenever the server has power, even when the server itself is "off". It has its own network port and offers:
- power control and sensor readings (temperature, fans, power draw)
- firmware updates and BIOS settings
- a remote console
- the **Redfish** HTTP API for programmatic control

Managing a machine through the BMC is called **out-of-band (OOB)**. Managing it from inside the running OS is **in-band**. NICo uses OOB access to discover, power-cycle and repair machines even when the tenant OS is broken.

**Racks:** servers mount in 19-inch racks measured in **rack units (U)**, 1.75 inches each, typically 42U or more. A **top-of-rack (ToR) switch** connects the servers in a rack to the datacenter network, and power distribution units supply power. Some racks also contain power shelves and NVSwitch trays.

**How NICo sees it.** Redfish splits a machine into three resource types:
- **Systems**: the computer as a whole, with its serial number, power state, boot order and PCIe devices. `SerialNumber` is critical for generating NICo's machine ID.
- **Chassis**: physical enclosures and cards. A DPU appears as `Card1`, and power shelves and switches have their own IDs.
- **Managers**: the BMCs themselves.

A NICo **ManagedHost** is one Host plus its DPUs. In the common case that's two BMCs: the host's and the DPU's.

**Analogy.** The BMC is like a building's caretaker who lives on site with their own phone line. Even when the building is closed and dark, you can call them to switch the lights on, check the boiler, or let someone in. The analogy breaks down because the caretaker can't see what happens inside the tenant's rooms (the OS), and because the BMC is reached over a separate management network, not the tenant's network.

### Worked example: Inventory your own machine, then map it to Redfish

**Step 1: CPUs and memory.**

```bash
lscpu | head -15     # sockets, cores, NUMA
free -h               # memory
```
On macOS, use `sysctl -n machdep.cpu.brand_string; sysctl hw.memsize`.

**Step 2: Drives and NICs.**

```bash
lsblk -d -o NAME,SIZE,MODEL   # drives
ip -br link                   # NICs and their MACs
```

**Step 3: System identity (firmware tables).**

```bash
sudo dmidecode -t system | grep -E 'Manufacturer|Product|Serial'
```
This is the in-band view of the serial number. A BMC reports the same value out of band as `SerialNumber` in `GET /redfish/v1/Systems/{id}`.

**Step 4: Read a Redfish Systems response.**

From NICo's docs sample: `"Id": "System.Embedded.1"`, `"SerialNumber": "J1234XY"`, `"PowerState": "On"`, `"Model": "PowerEdge R750"`, a `Boot.BootOrder` list, and a `PCIeDevices` array of links. Each field corresponds to something you just found locally.

### Your turn: finish it

Fill in which Redfish collection under `/redfish/v1/` you would GET for each item.

Host serial number & power state  -> /redfish/v1/Systems/{id}
BMC firmware version               -> /redfish/v1/___/{id}
BMC MAC address                    -> /redfish/v1/Managers/{id}/EthernetInterfaces/{id}
DPU card serial (Card1)            -> /redfish/v1/___/{id}

<details>
<summary>Answer</summary>

`Managers` (the BMC itself) and `Chassis` (physical cards and enclosures, where a DPU appears as `Card1`).

</details>

### Your turn: on your own

A tenant's OS has crashed and won't respond to SSH. List three things NICo can still do to that machine, and name the component that makes them possible.

<details>
<summary>Hint 1</summary>

SSH is in-band. What path doesn't depend on the OS?

</details>

<details>
<summary>Hint 2</summary>

Think about which component stays powered and has its own network port.

</details>

<details>
<summary>Hint 3</summary>

Look at the Redfish actions: ComputerSystem.Reset, boot source override, sensors.

</details>

<details>
<summary>Answer</summary>

Through the BMC, out of band over Redfish, NICo can still: power-cycle or reset the system (`ComputerSystem.Reset`), override the boot source to reinstall over the network, and read health sensors and event logs. The BMC runs independently of the host OS.

</details>

### Explain it

In your own words: Why does a bare-metal provisioning system need an out-of-band management path rather than relying on an agent installed in the server's operating system?

### Check

**1. Which Redfish resource type represents the BMC itself?**

A. Systems
B. Chassis
C. Managers
D. UpdateService

<details>
<summary>Answer</summary>

**C.** Managers

Systems is the computer, Chassis the physical enclosures and cards, and Managers the BMCs. UpdateService handles firmware updates.

</details>

**2. In the common NICo setup of one host with one DPU, how many BMCs make up a ManagedHost?**

A. One
B. Two
C. Zero
D. One per PCIe slot

<details>
<summary>Answer</summary>

**B.** Two

The host has a BMC and the DPU has its own separate BMC, as the glossary states.

</details>

**3. Which statement about out-of-band management is true?**

A. It requires the host OS to be running
B. It uses an endpoint independent of the host OS, typically the BMC
C. It is only used for monitoring, never for power control
D. It goes over the tenant's network

<details>
<summary>Answer</summary>

**B.** It uses an endpoint independent of the host OS, typically the BMC

OOB management works even when the OS is down, includes power control, and normally runs over a dedicated management network.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="pci-device-and-slot-address"></a>
## 10. PCI device and slot address

*Builds on: PCIe device (ch. 1)*

### Before you read

- In the PCI address `0000:ca:00.1`, what do you think the final `1` identifies?
- Is `ca` in `0000:ca:00.0` a decimal or a hexadecimal number? What is it in decimal?

<details>
<summary>Answers</summary>

- **In the PCI address `0000:ca:00.1`, what do you think the final `1` identifies?** The function number. Here it is the second port of a dual-port card, while `.0` is the first port.
- **Is `ca` in `0000:ca:00.0` a decimal or a hexadecimal number? What is it in decimal?** Hexadecimal. 0xca = 202, which is why Linux names that InfiniBand port `ibp202s0f0`.

</details>

### Explanation

Every PCI or PCIe function has an address in the form **`DDDD:BB:DD.F`**:
- **Domain**: 4 hex digits, usually `0000`. Large servers can have several domains.
- **Bus**: 2 hex digits, `00` to `ff`.
- **Device**: 2 hex digits, `00` to `1f`.
- **Function**: 1 digit, `0` to `7`.

You'll also see the shorthand **BDF** (bus:device.function). `lspci` drops the domain unless you pass `-D`.

Linux's predictable interface names encode the address in **decimal**: `ibp202s0f0` means bus 202 (0xca), slot (device) 0, function 0. NICo's docs often call this address the device's **slot**, as in `"slot": "0000:ca:00.0"`. Don't confuse it with a physical slot number printed on the motherboard.

**Why NICo cares.** A tenant selects an InfiniBand device by `device` name, `fabric` and `device_instance` (0, 1, ...). NICo has to turn that into exactly one piece of hardware, and do it the same way on every machine of the instance type. The design:
1. Filter the discovered devices by device name and fabric.
2. **Sort by PCI slot** and pick the N-th.

Why the slot rather than the GUID? GUIDs differ from card to card, so sorting by GUID could pick slot 4 on one machine and slot 5 on another. PCI slots are deterministic for machines with identical hardware, so a selection always lands on the same physical position. The design also proposes persisting the slot instead of the OS-specific sysfs `path`, because the path changes depending on which driver the discovery image uses.

**A sorting trap:** sorting addresses as strings only works if every address is zero-padded and in the same letter case. `"0000:EA:00.0" < "0000:cb:00.0"` as strings, because uppercase letters sort before lowercase. Parse the address into integers `(domain, bus, device, function)` and sort the tuples.

**Analogy.** A PCI address is like a postal address: country (domain), street (bus), house number (device), flat number (function). Sorting by address walks the street in a fixed order, which is the same in every identical town. Sorting by GUID is like sorting by the residents' names: it changes whenever people move. The analogy breaks down because PCI "house numbers" are written in hex and can be renumbered if the hardware or BIOS settings change.

### Worked example: Resolve a tenant's device_instance using NICo's Example 2

**Step 1: Lay out the discovered devices.**

All four are `MT28908 Family [ConnectX-6]`:
- `1234` IbFabric1 `0000:cb:00.0`
- `2345` IbFabric2 `0000:cd:00.0`
- `3456` IbFabric1 `0000:ea:00.0`
- `4567` IbFabric2 `0000:eb:00.0`

**Step 2: Parse addresses robustly.**

```python
def pci_key(s):
    dom, bus, rest = s.split(':')
    dev, fn = rest.split('.')
    return (int(dom,16), int(bus,16), int(dev,16), int(fn,16))
print(pci_key('0000:ca:00.1'))  # (0, 202, 0, 1)
```

**Step 3: Filter, sort, index.**

```python
devs = [('1234','IbFabric1','0000:cb:00.0'), ('2345','IbFabric2','0000:cd:00.0'),
        ('3456','IbFabric1','0000:ea:00.0'), ('4567','IbFabric2','0000:eb:00.0')]
def select(fabric, instance):
    c = sorted((d for d in devs if d[1]==fabric), key=lambda d: pci_key(d[2]))
    return c[instance][0]
print(select('IbFabric1',0), select('IbFabric1',1))  # 1234 3456
print(select('IbFabric2',0), select('IbFabric2',1))  # 2345 4567
```
This matches the doc's stated results.

**Step 4: Derive the Linux name.**

`0000:ca:00.0` → bus 0xca = 202, device 0, function 0 → `ibp202s0f0`. That is the name in the doc's `/sys/class/infiniband` listing.

### Your turn: finish it

Complete the function that builds the Linux-style InfiniBand name from a PCI address (domain 0000 assumed).

def ib_name(addr):
    _, bus, rest = addr.split(':')
    dev, fn = rest.split('.')
    return f"ibp{___}s{int(dev,16)}f{int(fn,16)}"

print(ib_name('0000:ca:00.1'))  # ibp202s0f1

<details>
<summary>Answer</summary>

`int(bus, 16)`. The bus is hex in the address but decimal in the interface name.

</details>

### Your turn: on your own

Devices of the same model and fabric are discovered with these slots: `0000:EB:00.0`, `0000:3b:00.0`, `0000:ca:00.1`, `0000:ca:00.0`. Which one is `device_instance: 2`? What would a naive string sort pick instead?

<details>
<summary>Hint 1</summary>

Convert each bus to decimal: 0xEB, 0x3b, 0xca.

</details>

<details>
<summary>Hint 2</summary>

Parsed order: 3b (59), then ca:00.0, then ca:00.1, then EB (235).

</details>

<details>
<summary>Hint 3</summary>

In ASCII, digits sort before uppercase letters, which sort before lowercase, so the string order is 3b, EB, ca:00.0, ca:00.1.

</details>

<details>
<summary>Answer</summary>

Parsed sort: `0000:3b:00.0`, `0000:ca:00.0`, `0000:ca:00.1`, `0000:EB:00.0`, so instance 2 is `0000:ca:00.1`. A naive string sort gives `3b`, `EB`, `ca:00.0`, `ca:00.1` and picks `0000:ca:00.0`, which is the wrong port.

</details>

### Explain it

In your own words: Why does NICo sort InfiniBand devices by PCI slot rather than by GUID when mapping a tenant's `device_instance` to hardware?

### Check

**1. In `0000:ca:00.0`, which part is the bus number?**

A. 0000
B. ca
C. 00
D. 0

<details>
<summary>Answer</summary>

**B.** ca

The format is domain:bus:device.function. `0000` is the domain, `00` the device and `0` the function.

</details>

**2. Why does NICo prefer the PCI slot over the sysfs `path` for storing device location?**

A. Paths are longer
B. The path depends on the OS and which driver the discovery image uses, while the slot is more stable
C. Slots include the GUID
D. Paths can't be stored in protobuf

<details>
<summary>Answer</summary>

**B.** The path depends on the OS and which driver the discovery image uses, while the slot is more stable

The doc says the path is OS- and driver-specific. Length and protobuf support aren't the issue.

</details>

**3. Two identical machines have different GUIDs on their ConnectX-6 ports. What happens if device_instance is resolved by sorting on GUID?**

A. The same physical port is always selected
B. The selection may land on different physical slots on different machines
C. NICo rejects the request
D. GUIDs are identical across machines, so nothing changes

<details>
<summary>Answer</summary>

**B.** The selection may land on different physical slots on different machines

GUIDs vary from card to card, so the sort order changes between machines. PCI slots are deterministic across identical hardware, which is why NICo sorts by slot.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md)

<a id="build-task"></a>
## Build task: Build a toy site-inventory resolver

**Goal:** Write a small Python tool that:
- reads a practice site file (TOML) and discovered-hardware data (YAML)
- normalises MAC addresses
- loads everything into SQLite and reports matched, missing and unexpected BMCs
- resolves a tenant InfiniBand selection by sorting PCI addresses
- checks NUMA locality against the GPU
- serialises the device list with Protocol Buffers

The file formats and the protobuf schema are made up for practice. They are not NICo's real schemas.

**Why it matters for NICo:** This is a laptop-sized version of jobs NICo does during ingestion. It cross-references BMC MACs against expected machines to find credentials, stores the discovered hardware in tables, and maps a tenant's (device, fabric, device_instance) selection to exactly one PCI slot. The traps built into the data (mixed MAC formats, YAML typing, mixed-case hex) are the kind that break real inventory tooling.

**You need:**

- Python 3.11 or newer (for tomllib): `python3 --version`
- A virtualenv with `pip install pyyaml grpcio-tools protobuf`
- Optional, for the stretch goal: Docker or Podman

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the input files</summary>

```bash
mkdir -p ~/inventory && cd ~/inventory
cat > site.toml <<'EOF'
# Practice file, NOT NICo's real site-config schema
site_name = "lab-1"

[[expected_machine]]
bmc_mac = "B8:3F:D2:90:95:82"
serial = "J1234XY"
rack = "R01"

[[expected_machine]]
bmc_mac = "7c:c2:55:00:00:01"
serial = "K9999ZZ"
rack = "R02"
EOF

cat > hardware.yaml <<'EOF'
discovered:
  - bmc_mac: "b8-3f-d2-90-95-82"
    host_serial: "J1234XY"
    arch: "x86_64"
    gpus:
      - slot: "0000:e9:00.0"
        numa_node: 1
    ib_devices:
      - {guid: "4567", fabric: "IbFabric2", slot: "0000:eb:00.0", numa_node: 1, device: "MT28908 Family [ConnectX-6]"}
      - {guid: "3456", fabric: "IbFabric1", slot: "0000:EA:00.0", numa_node: 1, device: "MT28908 Family [ConnectX-6]"}
      - {guid: "2345", fabric: "IbFabric2", slot: "0000:cd:00.0", numa_node: 0, device: "MT28908 Family [ConnectX-6]"}
      - {guid: "1234", fabric: "IbFabric1", slot: "0000:cb:00.0", numa_node: 0, device: "MT28908 Family [ConnectX-6]"}
  - bmc_mac: "0242.ac11.0002"
    host_serial: "UNKNOWN1"
    arch: "aarch64"
    gpus: []
    ib_devices: []
EOF
```
The uppercase `EA` slot and the unordered list are deliberate.

</details>

<details>
<summary>Step 2: Load and normalise</summary>

In `resolve.py`:
- Load `site.toml` with `tomllib` (open it with `'rb'`).
- Load `hardware.yaml` with `yaml.safe_load`.
- Write `norm_mac()` (strip every non-hex character, uppercase, add colons) and apply it to every MAC from both files.
- Raise an error if any MAC doesn't end up with exactly 12 hex digits.

</details>

<details>
<summary>Step 3: Store in SQLite and reconcile</summary>

Create an in-memory database (`sqlite3.connect(':memory:')`) with three tables:
- `expected_machine(bmc_mac TEXT PRIMARY KEY, serial TEXT, rack TEXT)`
- `discovered_bmc(bmc_mac TEXT PRIMARY KEY, host_serial TEXT, arch TEXT)`
- `ib_device(guid TEXT PRIMARY KEY, host_serial TEXT, fabric TEXT, slot TEXT, numa_node INTEGER, device TEXT)`

Then use SQL, not Python loops:
- A `JOIN` on `bmc_mac` to find **matched** BMCs.
- A `LEFT JOIN ... WHERE ... IS NULL` to find **missing** (expected but not discovered) and **unexpected** (discovered but not expected) BMCs.

</details>

<details>
<summary>Step 4: Resolve the tenant selection</summary>

Add a CLI: `--device`, `--fabric`, `--instance`.
1. Select the matching `ib_device` rows.
2. Sort them in Python with a `pci_key()` that parses `domain:bus:device.function` into an integer tuple.
3. Pick the N-th row.
4. Print the GUID, the canonical lowercase slot, the Linux name (`ibp{bus_decimal}s{dev}f{fn}`) and the NUMA node.

</details>

<details>
<summary>Step 5: Check NUMA locality</summary>

Compare the chosen device's `numa_node` with the host's GPU `numa_node`. Print `numa: local to GPU` or `numa: REMOTE from GPU`.

</details>

<details>
<summary>Step 6: Serialise with protobuf</summary>

Write `inv.proto`. The messages are deliberately named `Toy...` so you don't confuse them with NICo's real `PciDeviceProperties` (which uses vendor=1, device=2, path=3, numa_node=4). Because the field numbers differ, this toy schema is **not wire-compatible** with NICo's messages:
```protobuf
syntax = "proto3";
message ToyPciProps { string slot = 1; string device = 2; sint32 numa_node = 3; }
message ToyIbDevice { ToyPciProps pci_properties = 1; string guid = 2; string fabric = 3; }
message ToyIbDeviceList { repeated ToyIbDevice devices = 1; }
```
Compile it with `python -m grpc_tools.protoc -I. --python_out=. inv.proto`.

Then:
1. Build a `ToyIbDeviceList` from the database, sorted by slot.
2. Write it to `devices.bin`.
3. Read the file back and assert the decoded message equals the original.
4. Print `protobuf: N devices, B bytes, round-trip OK`.

</details>

<details>
<summary>Step 7: Report the architecture</summary>

Print `platform.machine()` for the machine running the tool. For each discovered BMC, also print its host's `arch`, and flag `aarch64` hosts as needing arm64 builds.

</details>

**Check it works:** Run:
```bash
python3 resolve.py --device "MT28908 Family [ConnectX-6]" --fabric IbFabric1 --instance 1
```
The output must contain these lines (extra lines are fine):
```
matched: B8:3F:D2:90:95:82 serial=J1234XY rack=R01
missing: 7C:C2:55:00:00:01
unexpected: 02:42:AC:11:00:02
selection: guid=3456 slot=0000:ea:00.0 name=ibp234s0f0 numa=1
numa: local to GPU
protobuf: 4 devices, <some> bytes, round-trip OK
```
Also check that `--fabric IbFabric2 --instance 0` gives `guid=2345`, `numa: REMOTE from GPU`. If you get `guid=1234` for the first command, you're string-sorting the slots.

<details>
<summary>If you get stuck</summary>

- `TOMLDecodeError` or `TypeError: file must be opened in binary mode`: `tomllib.load` needs `open(path, 'rb')`.
- GUIDs come out as ints, or a slot like `0000:00:01.0` comes out as a number: an unquoted YAML value was implicitly typed. Keep every ID and address quoted in YAML.
- Every BMC shows as both missing and unexpected: you normalised MACs in only one of the two files. Normalise before inserting into SQLite.
- The selection for IbFabric1 instance 1 returns 1234: you sorted slots as strings and uppercase `EA` sorted first. Sort with the parsed integer tuple, and lowercase the slot for display.
- `ModuleNotFoundError: inv_pb2`: run `protoc` from the same directory as `resolve.py`, or add that directory to the path.
- `sqlite3.IntegrityError` on insert: a primary key is duplicated. Check that you aren't loading the data twice.

</details>

**Stretch goal:** Package the tool in a container and build it for both `linux/amd64` and `linux/arm64`. For example, use `docker buildx build --platform linux/amd64,linux/arm64 .`, or Podman with `--platform`. Run the non-native image with `--platform` and confirm that `platform.machine()` prints the other architecture (under QEMU emulation) while the resolver output stays identical. Then add a check that rejects the inventory if two discovered BMCs normalise to the same MAC, to mirror NICo's switch rule that a MAC owned by another device is an error.

## Review notes

The first draft had major issues and was rewritten using the review; the notes below are from reviewing the rewrite.

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (YAML): Completion problem template is `  ___ name: R01`, with a space already after the blank, but the answer says the blank is a dash and a space. Filled in literally, this gives `  -  name: R01`, so `name` sits at column 5 while the next line `    units: 42` is at column 4. The indentation no longer lines up, and the file won't load as the stated dict. The answer's alignment explanation (four spaces in total) only works if the blank is just `-`. *Fix:* Change the first blank's answer to `-` (the template already has the space), or remove the space after the blank in the template: `  ___name: R01`.

---

[02-software-linux-basics.md →](02-software-linux-basics.md)
