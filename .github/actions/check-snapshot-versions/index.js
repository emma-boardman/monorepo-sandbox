const core = require('@actions/core');
const {getPackages} = require('@manypkg/get-packages');

async function main() {
  const cwd = process.cwd();

  const {packages} = await getPackages(cwd);

  const snapshotReleases = [];

  for (package of packages) {
    const {packageJson} = package;

    const pkgName = packageJson.name;
    const localVersion = packageJson.version;

    if (localVersion.includes('snapshot-release')) {
      snapshotReleases.push(`${pkgName}@${localVersion}`);
    }
  }

  if (snapshotReleases.length === 0) {
    core.setFailed(
      'No snapshot releases found. Please run `yarn changeset` to add a changeset.',
    );
  }

  core.setOutput('SNAPSHOT_RELEASES', snapshotReleases);
  core.setOutput('HAS_SNAPSHOTS', snapshotReleases.length > 0);
}

main().catch((err) => core.setFailed(err.message));
