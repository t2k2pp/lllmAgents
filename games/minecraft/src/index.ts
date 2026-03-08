import { ScreenshotGenerator } from './screenshot-generator.js';

function parseArgs(): {
  start: number;
  end: number;
  parallel: boolean;
  retries: number;
  delay: number;
  saveDir: string;
} {
  const args = process.argv.slice(2);

  let start;
  let end;
  let parallel = false;
  let retries = 3;
  let delay = 500;
  let saveDir = 'screenshots';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start':
      case '-s':
        start = parseInt(args[++i], 10);
        console.log(`Start seed: ${start}`);
        break;
      case '--end':
      case '-e':
        end = parseInt(args[++i], 10);
        console.log(`End seed: ${end}`);
        break;
      case '--parallel':
      case '-p':
        parallel = true;
        break;
      case '--retries':
      case '-r':
        retries = parseInt(args[++i], 10);
        break;
      case '--delay':
      case '-d':
        delay = parseInt(args[++i], 10);
        break;
      case '--output':
      case '-o':
        saveDir = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (!isNaN(parseInt(args[i], 10))) {
          if (isNaN(start)) {
            start = parseInt(args[i], 10);
          } else {
            end = parseInt(args[i], 10);
          }
        }
    }
  }

  if (start > end) {
    const temp = start;
    start = end;
    end = temp;
  }

  return { start, end, parallel, retries, delay, saveDir };
}

function printHelp(): void {
  console.log(`
Minecraft Seed Screenshot Generator

Usage:
  npm start [options]
  npm start <start-seed> <end-seed>

Options:
  -s, --start <seed>     Starting seed value (default: 1)
  -e, --end <seed>       Ending seed value (default: 1)
  -p, --parallel         Enable parallel mode (faster but may have more failures)
  -r, --retries <num>    Max retries per seed (default: 3)
  -d, --delay <ms>       Delay between retries in milliseconds (default: 500)
  -o, --output <dir>     Output directory for screenshots (default: screenshots)
  -h, --help             Show this help message

Examples:
  npm start 2 100                    # Generate screenshots for seeds 2-100
  npm start -s 1 -e 10 -p            # Parallel mode for seeds 1-10
  npm start 1 100 -r 5 -o ./images   # 5 retries, save to ./images
`);
}

async function main(): Promise<void> {
  const options = parseArgs();

  const generator = new ScreenshotGenerator(options);
  await generator.run();
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
