const { FileSynchronizer } = require('./packages/core/dist/sync/synchronizer');
const path = require('path');

async function testGitignoreIntegration() {
    console.log('Testing .gitignore integration...');
    
    const rootDir = path.resolve('.');
    const sync = new FileSynchronizer(rootDir, [], ['.js', '.ts', '.json', '.md']);
    
    await sync.initialize();
    
    // Check for changes to see what files are being tracked
    const changes = await sync.checkForChanges();
    
    console.log('Initialization complete. Now checking which patterns are loaded:');
    console.log('Ignore patterns loaded:', sync.getIgnorePatterns());
    
    console.log('\nNumber of files being tracked:', sync.getTrackedFiles().length);
    console.log('Sample tracked files:');
    const trackedFiles = sync.getTrackedFiles();
    trackedFiles.slice(0, 10).forEach(file => console.log('  -', file));
    if (trackedFiles.length > 10) {
        console.log(`  ... and ${trackedFiles.length - 10} more`);
    }
    
    // Check if specific directories like venv are being ignored
    const shouldIgnoreVenv = trackedFiles.some(file => file.includes('venv'));
    console.log('\nIs venv directory being indexed?', shouldIgnoreVenv ? 'YES (Problem!)' : 'NO (Good!)');
    
    console.log('\nChanges detected:', changes);
}

testGitignoreIntegration().catch(console.error);
