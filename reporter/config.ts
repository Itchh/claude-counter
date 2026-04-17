import { chmod, readFile, writeFile } from 'fs/promises'
import readline from 'readline'
import os from 'os'
import path from 'path'
import pc from 'picocolors'
import { COLOR_PRESETS } from './colors'

interface Config {
  name: string
  serverUrl: string
  secret: string
  color?: string
}

const HOME = os.homedir()
const CONFIG_PATH = path.join(HOME, '.leaderboard-reporter.json')

function openRl(): readline.Interface {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  rl.on('SIGINT', () => {
    process.stdout.write('\n' + pc.red('✖') + ' Cancelled.\n')
    process.exit(0)
  })
  return rl
}

function ask(
  rl: readline.Interface,
  label: string,
  defaultVal?: string,
  validate?: (v: string) => string | undefined,
): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultVal ? pc.dim(` (${defaultVal})`) : ''
    const prompt = (): void => {
      process.stdout.write(pc.cyan('◆') + '  ' + pc.bold(label) + suffix + '\n' + pc.dim('│') + '  ')
      rl.question('', (raw) => {
        const value = raw.trim() || defaultVal || ''
        const error = validate?.(value)
        if (error) {
          process.stdout.write(pc.red('│  ✖ ' + error) + '\n')
          prompt()
        } else {
          resolve(value)
        }
      })
    }
    prompt()
  })
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as Config
  } catch {
    console.error(pc.red('✖') + ` No config found at ${CONFIG_PATH}. Run "bun setup.ts" first.`)
    process.exit(1)
  }
}

async function saveConfig(config: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  await chmod(CONFIG_PATH, 0o600)
}

function log(msg: string): void {
  process.stdout.write(msg + '\n')
}

async function main(): Promise<void> {
  const config = await loadConfig()

  log('')
  log(pc.bold(pc.yellow('  LEADERBOARD CONFIG')))
  log(pc.dim('  ─────────────────────────'))
  log('')
  log(pc.dim('  Name:   ') + pc.bold(config.name))
  log(pc.dim('  Colour: ') + (config.color ? pc.bold(config.color) : pc.dim('not set')))
  log(pc.dim('  Server: ') + pc.dim(config.serverUrl))
  log('')

  const rl = openRl()

  const newName = await ask(rl, 'Display name', config.name, (v) => {
    if (!v) return 'Name is required'
    if (v.length > 20) return 'Keep it under 20 characters'
    return undefined
  })

  log('')
  log(pc.cyan('◆') + '  ' + pc.bold('Pick your timeline colour'))
  for (let i = 0; i < COLOR_PRESETS.length; i++) {
    const preset = COLOR_PRESETS[i]
    log(pc.dim('│') + `  ${pc.bold(String(i + 1))} — ${preset.label} (${preset.hex})`)
  }
  log(pc.dim('│') + '  Or enter a custom hex (e.g. #ff0000)')
  log(pc.dim('│') + '  Press enter to keep current')

  const colorInput = await ask(rl, 'Colour (number, hex, or enter to skip)', config.color, (v) => {
    if (!v) return undefined
    const num = parseInt(v, 10)
    if (!Number.isNaN(num) && num >= 1 && num <= COLOR_PRESETS.length) return undefined
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return undefined
    return 'Enter a number (1-8), a hex like #ff0000, or press enter to keep current'
  })

  let newColor = config.color
  if (colorInput && colorInput !== config.color) {
    const num = parseInt(colorInput, 10)
    newColor = !Number.isNaN(num) && num >= 1 && num <= COLOR_PRESETS.length
      ? COLOR_PRESETS[num - 1].hex
      : colorInput
  }

  rl.close()

  const updated: Config = { ...config, name: newName, color: newColor }
  await saveConfig(updated)

  log('')
  log(pc.green('◇') + '  Config updated!')
  log(pc.dim('  Name:   ') + pc.bold(updated.name))
  log(pc.dim('  Colour: ') + pc.bold(updated.color ?? 'not set'))
  log('')
  log(pc.dim('  Changes will take effect on the next reporter cycle (~30s).'))
  log('')
}

void main().catch((err) => {
  console.error(pc.red('✖') + ' ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
