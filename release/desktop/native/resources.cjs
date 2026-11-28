const {cp} = require("node:fs/promises");
const path = require("node:path");

module.exports = async function copyRuntimes(context) {
  const resources = process.platform === "darwin" ? path.join(context.appOutDir,"AVE.app/Contents/Resources") :
    path.join(context.appOutDir,"resources");
  for (const [source,name] of [[process.env.AVE_PACKAGE_PAYLOAD,"native-ave"],[process.env.AVE_PACKAGE_MEDIA,"native-media"]]) {
    await cp(source,path.join(resources,name),{recursive:true,verbatimSymlinks:true});
  }
};
