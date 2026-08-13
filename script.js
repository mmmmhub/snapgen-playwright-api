const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('patchright')

const prompt = process.env.PROMPT?.trim()
if (!prompt) throw new Error('PROMPT is required')

const provider = (process.env.SNAPGEN_PROVIDER || 'veo').toLowerCase()
if (!['veo', 'grok'].includes(provider)) throw new Error('SNAPGEN_PROVIDER must be veo or grok')

const settings = {
  aspect: process.env.SNAPGEN_ASPECT || '16:9',
  resolution: process.env.SNAPGEN_RESOLUTION || '1080p',
  duration: process.env.SNAPGEN_DURATION || '8s',
  orientation: process.env.SNAPGEN_ORIENTATION || 'Landscape (16:9)',
}

const timeoutMs = Number(process.env.SNAPGEN_JOB_TIMEOUT_SECONDS || 1200) * 1000
const headless = (process.env.SNAPGEN_HEADLESS || 'true').toLowerCase() !== 'false'
const outputDir = process.env.SNAPGEN_OUTPUT_DIR || process.cwd()

;(async () => {
  await fs.mkdir(outputDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(45_000)
  page.on('request', request => {
    if (request.url().includes('api.snapgen.ai')) console.log(`api_request ${request.method()} ${request.url()}`)
  })
  page.on('response', response => {
    if (response.url().includes('/api/video-gen/')) console.log(`api_response ${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', request => {
    if (request.url().includes('api.snapgen.ai')) console.log(`api_failed ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`)
  })

  try {
    await login(page)
    await openStudio(page)
    await dismissNotices(page)
    await disableNoticeOverlays(page)
    await configure(page)

    const previousMedia = await mediaSources(page)
    const responsePromise = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().includes(`/api/video-gen/${provider}`),
      { timeout: Math.min(timeoutMs, 240_000) },
    ).catch(() => null)

    await clickGenerate(page)
    await waitForCaptchaIfPresent(page)

    const response = await responsePromise
    if (!response) throw new Error('SnapGen did not return a video job response')
    const jobPayload = await response.json()
    const jobUuid = findJobUuid(jobPayload)
    if (!jobUuid) throw new Error(`Could not find the SnapGen job UUID: ${JSON.stringify(jobPayload).slice(0, 1000)}`)

    const result = await waitForJob(page, jobUuid, timeoutMs)
    const videoUrl = result.video_url || result.download_url
    const output = {
      prompt,
      provider,
      settings,
      job_uuid: jobUuid,
      video_url: result.video_url,
      download_url: result.download_url,
      status: result.status,
    }
    await fs.writeFile(path.join(outputDir, 'video-result.json'), JSON.stringify(output, null, 2) + '\n')
    await fs.writeFile(path.join(outputDir, 'video-url.txt'), `${videoUrl}\n`)
    await downloadVideo(videoUrl)
    console.log(JSON.stringify({ job_uuid: jobUuid, status: result.status, video_url: result.video_url, download_url: result.download_url }))
  } finally {
    await browser.close()
  }
})().catch(error => {
  console.error(`SnapGen generation failed: ${error.message}`)
  process.exitCode = 1
})

async function login(page) {
  await page.goto('https://snapgen.ai/auth/login', { waitUntil: 'domcontentloaded' })
  const email = page.locator('input[name="username"]')
  const studio = page.locator('textarea[placeholder*="Describe the video"]')
  await Promise.race([
    email.waitFor({ timeout: 60_000 }).catch(() => null),
    studio.waitFor({ timeout: 60_000 }).catch(() => null),
  ])
  if (await email.count()) {
    const password = page.locator('input[name="password"]')
    await email.fill(requiredEnv('SNAPGEN_EMAIL'))
    await password.fill(requiredEnv('SNAPGEN_PASSWORD'))
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }

  const redirected = page.waitForURL(url => !/\/auth\/login/i.test(url.toString()), { timeout: 90_000 }).catch(() => null)
  const studioRendered = studio.waitFor({ timeout: 90_000 }).catch(() => null)
  await Promise.race([redirected, studioRendered])
  await studio.waitFor({ timeout: 30_000 }).catch(() => null)
  if (!(await studio.count())) {
    const message = (await page.locator('body').innerText().catch(() => '')).slice(-600)
    throw new Error(`SnapGen login did not reach the studio: ${message}`)
  }
}

async function openStudio(page) {
  await page.goto('https://snapgen.ai/?hard=true', { waitUntil: 'domcontentloaded' })
  const studio = page.locator('textarea[placeholder*="Describe the video"]')
  await studio.waitFor({ timeout: 30_000 })
  const settingsVisible = provider === 'veo'
    ? page.locator('button[aria-label="16:9"]')
    : page.locator('button[aria-label="landscape"]')
  if (!(await settingsVisible.count())) {
    await page.goto(`https://snapgen.ai/app/video-gen/${provider}`, { waitUntil: 'domcontentloaded' })
    await studio.waitFor()
  }
}

async function dismissNotices(page) {
  const labels = ['Close and don\'t show again', "Don't show again", 'OK', 'Close']
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let clicked = false
    for (const name of labels) {
      const button = page.getByRole('button', { name, exact: true }).last()
      if (!(await button.isVisible().catch(() => false))) continue
      await button.click({ force: true, timeout: 4_000 }).catch(() => null)
      await page.waitForTimeout(500)
      clicked = true
    }
    if (!clicked) break
  }
}

async function disableNoticeOverlays(page) {
  await page.evaluate(() => {
    for (const overlay of document.querySelectorAll('div[data-state="open"].fixed.inset-0')) {
      overlay.remove()
    }
  })
}

async function configure(page) {
  // Wait for the prompt input to appear and allow the page some time to stabilize before typing.
  await page.waitForSelector('textarea[placeholder*="Describe the video"]', { timeout: 30_000 })
  await page.waitForTimeout(2_000)

  const promptField = page.locator('textarea[placeholder*="Describe the video"]')
  await promptField.fill(prompt, { force: true })

  // Give a small delay after filling the prompt before proceeding to click generate.
  await page.waitForTimeout(2_000)

  if (provider === 'veo') {
    await chooseOption(page, settings.aspect)
    await chooseOption(page, settings.resolution)
    await chooseOption(page, settings.duration)
  } else {
    await chooseOption(page, settings.orientation)
    await chooseOption(page, settings.resolution === '1080p' ? 'High' : settings.resolution)
    await chooseOption(page, settings.duration === '8s' ? '6 seconds' : settings.duration)
  }
}

async function chooseOption(page, label) {
  const aria = {
    'Landscape (16:9)': 'landscape',
    'Portrait (9:16)': 'portrait',
    'Square (1:1)': 'square',
    'Vertical (2:3)': '2:3',
    'Horizontal (3:2)': '3:2',
    Standard: '480p',
    High: '720p',
    '4s': '4',
    '6s': '6',
    '8s': '8',
    '6 seconds': '6',
    '10 seconds': '10',
  }[label] || label
  const option = page.locator(`button[aria-label="${escapeAttribute(aria)}"]`)
  if (await option.count()) {
    await option.click({ force: true })
    return
  }
  const text = page.getByRole('button', { name: label, exact: true })
  if (await text.count()) {
    await text.click({ force: true })
    return
  }
  throw new Error(`SnapGen option not found: ${label}`)
}

async function clickGenerate(page) {
  const name = provider === 'veo' ? 'Generate Video' : 'Generate with Grok'
  const button = page.getByRole('button', { name, exact: true })
  const promptValue = await page.locator('textarea[placeholder*="Describe the video"]').inputValue()
  console.log(`generate_state disabled=${await button.isDisabled()} prompt_length=${promptValue.length}`)
  if (await button.isDisabled()) throw new Error('SnapGen kept the generate button disabled after prompt configuration')
  await page.waitForTimeout(2_000)
  await button.click()
}

async function waitForCaptchaIfPresent(page) {
  await page.waitForTimeout(2_000)
  const challenge = page.locator(
    'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], #veo-turnstile-modal, #grok-turnstile-modal, #sora-turnstile-modal',
  )
  const visibleChallenge = await challenge.evaluateAll(elements => elements.some(element => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  })).catch(() => false)
  if (!visibleChallenge) return
  console.log('Cloudflare challenge detected; waiting for it to clear')
  try {
    await page.waitForFunction(() => {
      const elements = [...document.querySelectorAll(
        'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], #veo-turnstile-modal, #grok-turnstile-modal, #sora-turnstile-modal',
      )]
      return elements.every(element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0
      })
    }, null, { timeout: Number(process.env.SNAPGEN_CAPTCHA_TIMEOUT_SECONDS || 180) * 1000 })
  } catch {
    throw new Error('Cloudflare Turnstile still requires human verification; GitHub Actions cannot continue automatically')
  }
}

async function waitForJob(page, uuid, timeout) {
  const started = Date.now()
  let lastStatus = ''
  while (Date.now() - started < timeout) {
    const state = await page.evaluate(async jobUuid => {
      const auth = JSON.parse(localStorage.getItem('authStore') || '{}')
      const response = await fetch(`https://api.snapgen.ai/api/history/${jobUuid}`, {
        headers: { Authorization: `Bearer ${auth.access_token}` },
      })
      if (!response.ok) return { http_status: response.status }
      const job = await response.json()
      const video = job.generated_video?.[0] || {}
      return {
        status: job.status,
        status_desc: job.status_desc || '',
        percentage: job.status_percentage,
        video_url: video.video_url || null,
        download_url: video.file_download_url || null,
        error: job.error_message || video.error_message || '',
      }
    }, uuid)

    const statusLine = JSON.stringify({ status: state.status, percentage: state.percentage, status_desc: state.status_desc })
    if (statusLine !== lastStatus) {
      console.log(statusLine)
      lastStatus = statusLine
    }
    if (state.video_url || state.download_url) return state
    if (state.error || state.http_status) throw new Error(state.error || `SnapGen status request failed: ${state.http_status}`)
    await page.waitForTimeout(10_000)
  }
  throw new Error(`Timed out after ${Math.round(timeout / 60_000)} minutes waiting for SnapGen`)
}

async function downloadVideo(url) {
  if (!url) throw new Error('SnapGen returned no video URL')
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Could not download the generated video: HTTP ${response.status}`)
  const file = await fs.open(path.join(outputDir, 'video.mp4'), 'w')
  try {
    for await (const chunk of response.body) await file.write(chunk)
  } finally {
    await file.close()
  }
}

async function mediaSources(page) {
  return page.locator('video, a[href*=".mp4"], a[download]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('src') || element.getAttribute('href')).filter(Boolean),
  )
}

function findJobUuid(value) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.uuid === 'string' && value.uuid.length > 20) return value.uuid
  for (const child of Object.values(value)) {
    const uuid = findJobUuid(child)
    if (uuid) return uuid
  }
  return null
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`)
  return process.env[name]
}

function escapeAttribute(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
