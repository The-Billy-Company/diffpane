---
doc_radar:
  sentinels:
    - file: app/backend/tools/billy-contracts/contracts.ts
      contains: ['readBillyContractDiff', 'contracts/operate/codegen/generators.toml']
    - file: app/backend/tools/billy-contracts/protobuf.ts
      contains: ['SOURCE_HEADER', 'protobufGroups']
---

# Billy contract relationships

Read the working copy of Billy’s generator registry and connect the selected review file to its declared inputs and changed outputs. Protobuf bindings use generated source headers when they are available. A matching output name alone is shown as a possible match. These reads do not run a generator.
