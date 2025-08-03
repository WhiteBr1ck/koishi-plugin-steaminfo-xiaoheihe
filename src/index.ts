import { Context, Schema, segment } from 'koishi'
import Puppeteer from 'koishi-plugin-puppeteer'

export const name = 'steaminfo-xiaoheihe'
export const using = ['puppeteer']

export interface Config {
  cookies: string;
  waitTimeout: number;
  renderDelay: number;
  deviceScaleFactor: number;
  imageType: 'jpeg' | 'png';
  imageQuality: number;
  showGameTitle: boolean;
  showOnlineCount: boolean;
  debug: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    cookies: Schema.string()
      .description('【选填】【建议填写】登录小黑盒后获取的Cookie。获取方式请查看readme。')
      .role('secret'),
  }).description('身份验证'),

  Schema.object({
    waitTimeout: Schema.number().description('页面加载的超时时间（毫秒）。').default(60000),
    renderDelay: Schema.number()
      .description('在内容框架出现后，额外等待渲染的时间（毫秒）。')
      .default(5000),
    deviceScaleFactor: Schema.number()
      .min(1).max(3).step(0.5)
      .description('截图清晰度（设备缩放因子）。设置为 2 可让文字更加清晰。')
      .default(2),
    imageType: Schema.union(['jpeg', 'png'])
      .description('截图的图片格式。PNG 无损但文件较大，JPEG 有损但文件较小。')
      .default('jpeg'),
    imageQuality: Schema.number()
      .min(1).max(100)
      .description('图片质量，仅在格式为 jpeg 时生效。')
      .default(95),
  }).description('高级设置'),

  Schema.object({
    showGameTitle: Schema.boolean().description('是否在截图前显示“游戏名”文本。').default(true),
    showOnlineCount: Schema.boolean().description('是否在截图前显示“当前在线”文本。').default(true),
  }).description('显示设置'),

  Schema.object({
    debug: Schema.boolean()
      .description('启用后，将在控制台输出详细的调试日志。')
      .default(false),
  }).description('调试'),
])

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('xiaoheihe')
  const log = (message: string) => {
    if (config.debug) {
      logger.info(message)
    }
  }

  ctx.command('xiaoheihe <game:text>', '小黑盒游戏页面截图')
    .alias('小黑盒')
    .action(async ({ session }, game) => {
      if (!game) return '请输入要搜索的游戏名称。'

      let page;
      let tempMessageId: string;

      try {
        const tempMessage = [
          segment.quote(session.messageId),
          '请求已收到，正在为您生成游戏截图，请稍候...'
        ]
        const sentMessageIds = await session.send(tempMessage)
        tempMessageId = sentMessageIds[0]
        log(`收到截图请求，游戏名称: "${game}"。临时消息ID: ${tempMessageId}`)
        
        page = await ctx.puppeteer.page()
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
        
        if (config.cookies) {
          const cookies = config.cookies.split(';').map(pair => {
            const parts = pair.trim().split('=')
            const name = parts.shift()
            const value = parts.join('=')
            return { name, value, domain: '.xiaoheihe.cn' }
          })
          await page.setCookie(...cookies)
          log(`成功注入 ${cookies.length} 个 Cookie。`)
        } else {
          log('未配置Cookie，以游客身份访问。')
        }
        
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: config.deviceScaleFactor })
        log(`视口已设置为 1280x800，缩放因子为 ${config.deviceScaleFactor}。`)
        
        const searchUrl = `https://www.xiaoheihe.cn/app/search?q=${encodeURIComponent(game)}`
        log(`准备导航到搜索页面: ${searchUrl}`)
        await page.goto(searchUrl, { waitUntil: 'load', timeout: config.waitTimeout })
        
        const gameLinkSelector = 'a[href*="/app/topic/game/"]'
        let gamePageHref;
        try {
          log(`将使用选择器 "${gameLinkSelector}" 寻找游戏链接...`)
          await page.waitForSelector(gameLinkSelector, { timeout: 10000 })
          gamePageHref = await page.$eval(gameLinkSelector, el => el.getAttribute('href'))
        } catch (e) {
          if (config.debug) logger.warn('在搜索页未能找到游戏链接，可能是Cookie失效、游戏不存在或页面结构更新。')
          const screenshot = await page.screenshot({ fullPage: true })
          await session.send(['未能找到游戏专题链接。这是当前页面的截图：', segment.image(screenshot)])
          return
        }
        
        const finalUrl = `https://www.xiaoheihe.cn${gamePageHref}`
        log(`已获取详情页链接，正在导航到: ${finalUrl}`)
        await page.goto(finalUrl, { waitUntil: 'load', timeout: config.waitTimeout })
        
        const mainContentSelector = '.game-detail-page-detail'
        log(`等待核心内容 "${mainContentSelector}" 出现...`)
        await page.waitForSelector(mainContentSelector, { timeout: config.waitTimeout })
        log('核心内容容器已出现！')
        
        let extractedTitle = game
        let onlineInfo = '获取失败'
        try {
          const titleSelector = '.game-name p.name'
          const onlineNumberSelector = '.data-list .data-item:first-child .editor p'
          const onlineUnitSelector = '.data-list .data-item:first-child .editor p + p'
          const onlineLabelSelector = '.data-list .data-item:first-child > .p2'

          log('等待标题和数据项出现...')
          await Promise.all([
            page.waitForSelector(titleSelector, { timeout: 10000 }),
            page.waitForSelector(onlineNumberSelector, { timeout: 10000 }),
            page.waitForSelector(onlineLabelSelector, { timeout: 10000 }),
          ])
          log('标题和数据项均已出现，开始提取...')
          
          const title = await page.$eval(titleSelector, el => el.textContent.trim())
          const number = await page.$eval(onlineNumberSelector, el => el.textContent.trim())
          const label = await page.$eval(onlineLabelSelector, el => el.textContent.trim())

          let unit = ''
          try {
            unit = await page.$eval(onlineUnitSelector, el => el.textContent.trim())
          } catch {}

          extractedTitle = title
          onlineInfo = `${label}：${number}${unit}`
          log(`成功提取到标题: "${extractedTitle}"`)
          log(`成功提取到在线信息: "${onlineInfo}"`)
        } catch {
          log(`无法从页面提取标题或在线人数，将使用用户输入的游戏名。`)
        }
        
        log(`额外等待 ${config.renderDelay} 毫秒以确保内容渲染完成...`)
        await new Promise(resolve => setTimeout(resolve, config.renderDelay))
        
        const selectorsToHide = [
          '.game-detail-section-comment',
          '.game-detail-section-similar-games',
          '.publish-score-wrapper',
        ]
        const selectorToModify = '.game-detail-section-footer'
        log(`准备隐藏 ${selectorsToHide.length} 个元素，并修正 1 个悬浮元素的位置...`)
        await page.evaluate((toHide, toModify) => {
          for (const selector of toHide) {
            const element = document.querySelector(selector)
            if (element) (element as HTMLElement).style.display = 'none'
          }
          const floatingElement = document.querySelector(toModify)
          if (floatingElement) (floatingElement as HTMLElement).style.position = 'static'
        }, selectorsToHide, selectorToModify)
        
        const element = await page.$(mainContentSelector)
        if (!element) throw new Error('无法定位到已等待的核心内容元素')
        
        log(`正在执行最终的精准截图... 格式: ${config.imageType}`)
        const imageBuffer = await element.screenshot({ type: config.imageType, quality: config.imageType === 'jpeg' ? config.imageQuality : undefined })
        log('截图成功！')
        
        const message = []
        const textLines = []
        if (config.showGameTitle) textLines.push(`游戏名：${extractedTitle}`)
        if (config.showOnlineCount && onlineInfo !== '获取失败') textLines.push(onlineInfo)
        const textContent = textLines.join('\n')
        if (textContent) message.push(textContent)
        message.push(segment.image(imageBuffer))
        
        await session.send(message)

      } catch (error) {
        logger.error('截图过程中发生严重错误:', error)
        let errorMsg = `截图失败，请检查控制台错误日志。`
        if (error.name === 'TimeoutError') {
          errorMsg = `截图失败，页面加载超时。可能是小黑盒服务器繁忙或您的网络不稳定。`
        }
        await session.send(errorMsg)
      } finally {
        if (page) {
          await page.close()
          log('浏览器页面已关闭。')
        }
        if (tempMessageId) {
          try {
            await session.bot.deleteMessage(session.channelId, tempMessageId)
            log(`临时消息 ${tempMessageId} 已撤回。`)
          } catch (e) {
            logger.warn(`撤回临时消息失败: ${e.message}`)
          }
        }
      }
    })
}