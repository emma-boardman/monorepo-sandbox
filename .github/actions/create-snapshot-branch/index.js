const core = require('@actions/core');
const fs = require('fs');
const {getExecOutput} = require('@actions/exec');
const github = require('@actions/github');

const token = core.getInput('GITHUB_TOKEN');
const issue = core.getInput('ISSUE');
const octokit = github.getOctokit(token);

/**
 * This GitHub actions function allows us to create a branch containing Commits from the source `/snapit` PR, and a snapshot version number
 *
 * The new branch is required to trigger a BuildKite pipeline that will publish the snapshot release.
 *
 * The action does 3 things:
 * 1. Creates the snapshot branch, using the source branch name and last commit sha
 * 2. Captures the version update created by `changeset version` earlier in the workflow
 * 3. Commits the updated version file to the snapshot branch
 *
 * Shopify does not allow the use of unverified third party GitHub actions in private repositories. This is why we have to write our own.

 * In the future, we should write this function in Typescript and add it to Shopify's github actions repo.
 * https://github.com/Shopify/github-actions
 */

 const main = async () => {
  try {
    // Create the snapshot branch, using the source branch name and last commit sha
    const branchDetails = await createReleaseBranch(octokit);

    const {branch, sha} = branchDetails;

    console.log('branch Details', branchDetails);

    // Commit an updated version file to the snapshot branch
    await createVersionCommit(octokit, branch, sha);

    core.setOutput('SNAPSHOT_BRANCH_REF', branch.replace('refs/', ''));
  } catch (err) {
    core.setFailed(`Failed to create snapshot branch and commit: ${err}`);
  }
}

async function createReleaseBranch(octokit) {
  // Get source PR information
  const {data} = await octokit.rest.pulls.get({
    pull_number: issue,
    ...github.context.repo,
  });

  // Get source branch information
  const branch = data.head.ref.replace('refs/heads/', '');
  const lastCommit = data.head.sha;

  // Use source branch information to create snapshot branch information
  const snapshotBranch = `refs/heads/snapshot-release/${branch}`;
  const snapshotRef = `heads/snapshot-release/${branch}`;

  // Check if a snapshot branch already exists for this PR
  try {
    await octokit.rest.repos.getBranch({
      ...github.context.repo,
      branch: snapshotBranch,
    });

    // if a snapshot branch exists, delete and recreate with latest commit
    await octokit.rest.git.deleteRef({
      ref: snapshotRef,
      ...github.context.repo,
    });

    return createBranchRef(snapshotBranch, lastCommit);
  } catch (error) {
    // if a snapshot branch does not exist, create new branch with the latest commit
    if (error.name === 'HttpError' && error.status === 404) {
      return createBranchRef(snapshotBranch, lastCommit);
    } else {
      throw Error(error);
    }
  }
}

// Creates a snapshot branch that mirrors the source branch
async function createBranchRef(snapshotBranch, lastCommit) {
  await octokit.rest.git.createRef({
    ref: snapshotBranch,
    sha: lastCommit,
    ...github.context.repo,
  });

  return {branch: snapshotBranch, sha: lastCommit};
}

// Commit the updated version file to the snapshot branch
async function createVersionCommit(octokit, branch, currentCommitSha) {
  const versionFiles = await getUncomittedPackageVersionFiles();

  if (versionFiles.length > 0) {
    core.info('✅ Version files found. Creating Snapshot commit', versionFiles);

    // Get commit tree sha
    const {data: commitData} = await octokit.rest.git.getCommit({
      ...github.context.repo,
      commit_sha: currentCommitSha,
    });

    console.log('currentSha', currentCommitSha);

    console.log('commitData', commitData);

    const currentCommitTreeSha = commitData.tree.sha;

    core.info('✅ Retrived commit tree SHA', currentCommitTreeSha);

    const versionFileBlobs = await Promise.all(
      versionFiles.map(createBlobForFile(octokit)),
    );

    core.info('✅ Retrived version file blobs', versionFileBlobs);

    const newTree = await createNewTree(
      octokit,
      versionFileBlobs,
      versionFiles,
      currentCommitTreeSha,
    );


    console.log('newtree', newtree);

    const newCommit = await createNewCommit(
      octokit,
      'Snapshot release',
      newTree.sha,
      currentCommitSha,
    );

    // const newCommit = await octokit.rest.git.createCommit({
    //   message: 'Snapshot release',
    //   tree: newTree.sha,
    //   parents: [currentCommitSha],
    //   ...github.context.repo,
    // }).data;

    console.log('newcommit', newcommit);

    await setBranchToCommit(octokit, branch, newCommit.sha);
  }
}

const createNewCommit = async (
  octokit,
  message,
  currentTreeSha,
  currentCommitSha,
) =>
  (
    await octokit.rest.git.createCommit({
      message,
      tree: currentTreeSha,
      parents: [currentCommitSha],
      ...github.context.repo,
    })
  ).data;


const createBlobForFile = (octokit) => async (fileName) => {
  const content = await fs.readFileSync(fileName).toString();

  const blobData = await octokit.rest.git.createBlob({
    content,
    ...github.context.repo,
  });
  return blobData.data;
};

const createNewTree = async (octokit, blobs, paths, parentTreeSha) => {
  const tree = blobs.map(({sha}, index) => ({
    path: paths[index],
    mode: `100644`,
    type: `blob`,
    sha,
  }));
  const {data} = await octokit.rest.git.createTree({
    tree,
    base_tree: parentTreeSha,
    ...github.context.repo,
  });
  return data;
};

const setBranchToCommit = (octokit, branch, newCommitSha) =>
  octokit.rest.git.updateRef({
    ref: branch.replace('refs/', ''),
    sha: newCommitSha,
    ...github.context.repo,
  });

async function getUncomittedPackageVersionFiles() {
  // output returns a string, with each file name and status separated by linebreaks.
  const output = await getExecOutput('git', ['status', '--porcelain']);

  // Tranform string into an array
  let files = output.stdout.split(/\r?\n/);
  // Remove empty entry after final linebreak
  files = files.splice(0, files.length - 1);

  // only return files that were generated by "changeset version"
  // TODO: ideally only from packages, not github actions
  const versionFileIdentifiers = /package.json|.changeset|CHANGELOG.md/;
  const uncomittedVersionFiles = files.filter((file) =>
    versionFileIdentifiers.test(file),
  );

  return uncomittedVersionFiles.reduce(function (isModified, file) {
    // Initial Status format: XY PATH
    const fileDetails = file.replace(/^\s+/, '').split(/[ ]/);
    // Status codes: https://git-scm.com/docs/git-status
    const status = fileDetails[0];
    const name = fileDetails.pop();
    if (!status.includes('D')) {
      isModified.push(name);
    }
    return isModified;
  }, []);
}

main().catch((err) => core.setFailed(err.message));
