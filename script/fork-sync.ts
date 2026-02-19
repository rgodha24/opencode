#!/usr/bin/env bun

import { $ } from "bun"

// Fork feature branches to merge on top of upstream/dev
// Order matters - these are merged sequentially
const FORK_BRANCHES = [
  "fork/failover", // cross-provider failover with oauth rotation and account pinning
]

interface Result {
  name: string
  success: boolean
  reason?: string
}

async function main() {
  const results: Result[] = []

  // Fetch upstream
  console.log("Fetching upstream/dev...")
  await $`git fetch upstream dev`

  // Fetch origin (for fork branches)
  console.log("Fetching origin...")
  await $`git fetch origin`

  // Clean any local changes before checkout
  console.log("Cleaning working directory...")
  await $`git reset --hard HEAD`.nothrow()
  await $`git clean -fd`.nothrow()

  // Start fresh from upstream/dev
  console.log("Checking out fresh dev from upstream/dev...")
  await $`git checkout -B dev upstream/dev`

  // Remove upstream workflow files that would require workflows permission to push
  // Keep only our fork-sync.yml which will be added back when merging fork/failover
  console.log("Removing upstream workflow files...")
  await $`git rm -rf .github/workflows/`.nothrow()
  await $`git commit -m "chore: remove upstream workflows" --allow-empty`.nothrow()

  // Merge fork branches
  console.log("\n=== Merging fork branches ===")
  for (const branch of FORK_BRANCHES) {
    console.log(`\nMerging ${branch}...`)
    try {
      await $`git merge --no-ff origin/${branch} -m ${"automated: merge fork commits"}`
      console.log(`  OK`)
      results.push({ name: branch, success: true })
    } catch {
      console.log(`  FAILED - merge conflicts`)
      await $`git merge --abort`.nothrow()
      await $`git checkout -- .`.nothrow()
      await $`git clean -fd`.nothrow()
      results.push({ name: branch, success: false, reason: "merge conflicts" })
    }
  }

  // Summary
  console.log("\n=== Summary ===")
  const succeeded = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  console.log(`\nSucceeded (${succeeded.length}):`)
  for (const r of succeeded) console.log(`  - ${r.name}`)

  if (failed.length > 0) {
    console.log(`\nFailed (${failed.length}):`)
    for (const r of failed) console.log(`  - ${r.name}: ${r.reason}`)
  }

  // Check if we need to push
  console.log("\nChecking if dev branch has changes...")
  try {
    await $`git fetch origin dev`
    const local = (await $`git rev-parse dev^{tree}`.text()).trim()
    const remote = (await $`git rev-parse origin/dev^{tree}`.text()).trim()

    if (local === remote) {
      console.log("No changes, skipping push")
      return
    }
  } catch {
    // origin/dev might not exist, that's fine
  }

  console.log("Force pushing to origin/dev...")
  await $`git push origin dev --force --no-verify`

  console.log("\nDone!")

  if (failed.length > 0) {
    throw new Error(`${failed.length} fork branch(es) failed to merge`)
  }
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
