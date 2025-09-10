const fs = require('fs');
const path = require('path');

/**
 * Synchronizes version numbers from root package.json to mobile and client package.json files
 */
function syncVersions() {
  try {
    // Read the root package.json
    const rootPackagePath = path.join(__dirname, 'package.json');
    const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
    const version = rootPackage.version;

    console.log(`Root package version: ${version}`);

    // Paths to update
    const packagesToUpdate = [
      './mobile/package.json',
      './client/package.json'
    ];

    // Update each package.json file
    packagesToUpdate.forEach(packagePath => {
      const fullPath = path.join(__dirname, packagePath);
      
      if (fs.existsSync(fullPath)) {
        const packageData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const oldVersion = packageData.version;
        
        packageData.version = version;
        fs.writeFileSync(fullPath, JSON.stringify(packageData, null, 2) + '\n');
        
        console.log(`Updated ${packagePath}: ${oldVersion} → ${version}`);
      } else {
        console.warn(`Warning: ${packagePath} not found`);
      }
    });

    console.log('Version synchronization completed successfully!');
  } catch (error) {
    console.error('Error synchronizing versions:', error.message);
    process.exit(1);
  }
}

// Run the function if this script is executed directly
if (require.main === module) {
  syncVersions();
}

module.exports = syncVersions;
