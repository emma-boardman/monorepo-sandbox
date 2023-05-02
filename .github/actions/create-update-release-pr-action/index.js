const {getOctokitOptions, GitHub} = require('@actions/github/lib/utils');
const core = require('@actions/core');
const {getExecOutput} = require('@actions/exec');
const github = require('@actions/github');
const fs = require('fs');
const {createPullRequest} = require('octokit-plugin-create-pull-request');

async function main() {

/**
 * This GitHub actions function allows us to create a new update version PR using the outputs of `yarn changesets version`
 *
 * It does three things:
 * 1. Gathers the uncommitted files related to `yarn changesets version` (package.json, .changeset folder, changelog.md)
 * 2. Creates or updates the version update PR with relevant changeset file changes
 * 3. Adds unpublished changelog entries to the version update PR description
 *
 * Shopify does not want us to use unverified third party GitHub actions in private repositories. This is why we have to write our own.
 *
 * In the future, we should write this function in Typescript and add it to Shopify's github actions repo.
 * https://github.com/Shopify/github-actions
 */


  const context = github.context;
  const token = core.getInput('GITHUB_TOKEN');

  const Octokit = GitHub.plugin(createPullRequest);

  const octokit = new Octokit(getOctokitOptions(token));

  const commitMessage = 'Version Packages';

  console.log('ℹ️ Checking for Version files');
  const versionFiles = await getUncomittedVersionFiles();

  if (versionFiles.length > 0) {
    console.log('✅ Version files found. Creating Version Package PR');

    const {data} = await octokit.createPullRequest({
      ...context.repo,
      title: commitMessage,
      body: getPRDescription(versionFiles),
      head: `changeset-release/main`,
      update: true,
      createWhenEmpty: false,
      changes: [
        {
          commit: commitMessage,
          files: getFileContentForCommit(versionFiles),
          emptyCommit: false,
        },
      ],
    });

    await octokit.rest.issues.addLabels({
      ...context.repo,
      labels: ['Version Package'],
      issue_number: data.number,
    });

    console.log('✅ Succesfully created/updated PR #', data.number);
    return data.number;
  } else {
    console.log(
      '⛔ No Version files found. Exiting without creating a Version Package PR.',
    );
  }
}

async function getUncomittedVersionFiles() {
  // Output returns a string, with each file name and status seperated by linebreaks.
  const output = await getExecOutput('git', ['status', '--porcelain']);

  // Tranform string into an array
  let files = output.stdout.split(/\r?\n/);
  // Remove empty entry after final linebreak
  files = files.splice(0, files.length - 1);

  // Only return files that were generated by "changeset version"
  const versionFileIdentifiers = /package.json|.changeset|CHANGELOG.md/;
  const uncomittedVersionFiles = files.filter((file) =>
    versionFileIdentifiers.test(file),
  );

  console.log('uncomitted version files', uncomittedVersionFiles);

  return uncomittedVersionFiles.map((file) => {
    // Initial Status format: XY PATH
    const fileDetails = file.replace(/^\s+/, '').split(/[ ]/);
    // Status codes: https://git-scm.com/docs/git-status
    const status = fileDetails[0];
    const name = fileDetails.pop();

    return {
      name,
      status,
    };
  });
}

function getFileContentForCommit(versionFiles) {
  const commitObj = versionFiles.reduce((obj, fileDetails) => {
    const {name, status} = fileDetails;

    // If file was deleted, set content to an empty string
    // Otherwise, capture local file changes for commit
    return {
      ...obj,
      [name]: status === 'D' ? null : getFileContent(name),
    };
  }, {});

  return commitObj;
}

function getFileContent(fileName) {
  return fs.readFileSync(fileName).toString();
}

function getChangelogFileContent(fileName) {
  const fileContent = getFileContent(fileName);

  // Capture package name 
  const packageNameStartIndex = fileContent.indexOf('# @');
  const packageNameEndIndex = fileContent.indexOf('\n');
  const packageName = fileContent.substring(packageNameStartIndex, packageNameEndIndex).replace(/[#\n]/g, '');

  console.log('packageName', packageName);

  // Capture new version number
  const newVersionNumberStartIndex = fileContent.indexOf('\n## ') + 1;
  const newVersionNumberEndIndex = fileContent.indexOf('\n### ', newVersionNumberStartIndex + 1) + 1;
  const newVersionNumber = fileContent.substring(newVersionNumberStartIndex, newVersionNumberEndIndex).replace(/[#\n]/g, '');

  console.log('packageNumber', newVersionNumber);
  console.log('packageNumber unstripped', fileContent.substring(newVersionNumberStartIndex, newVersionNumberEndIndex));

  // Capture new version changelog content
  const lastVersionIndex =
    fileContent.indexOf('\n## ', newVersionNumberEndIndex + 1);
  const isFirstVersion = lastVersionIndex < 0;
  const newVersionContent = fileContent.substring(
    newVersionNumberEndIndex,
    isFirstVersion ? fileContent.length - 1 : lastVersionIndex - 1,
  );

  return `## ${packageName}@${newVersionNumber} \n\n ----- \n\n ${newVersionContent} \n\n `;
}


function getPRDescription() {
  const introContent =
    "This PR was opened by the [OSUI Version Package](https://github.com/shopify/online-store-ui/.github/actions/changesets/close-existing-release-pr-action/action.yml) GitHub action. When you're ready to do a release, you can merge this and the packages will be published to npm automatically. If you're not ready to do a release yet, that's fine, whenever you add more changesets to main, a fresh Version Package PR will be created.";

  let description = `${introContent} \n\n ----- \n`;


  const changelogIdentifier = /CHANGELOG.md/;
  const changelogFiles = versionFiles.filter((fileDetails) => {
    const {name} = fileDetails;
    return changelogIdentifier.test(name);
  });

 
  changelogFiles.forEach(function (fileDetails) {
    const {name} = fileDetails;
    const fileContent = getChangelogFileContent(name);

    console.log('fileContent', fileContent);

    description += fileContent;
  });
  return description;
}


main().catch((err) => core.setFailed(err.message));
