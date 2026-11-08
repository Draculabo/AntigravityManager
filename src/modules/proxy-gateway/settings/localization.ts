export const imageSendWindowEnglish = {
  title: 'Image history sent to models',
  description:
    'Choose which historical images accompany each request. Omission changes the send view and keeps retained originals.',
  enabled: 'Limit image history',
  'enabled-help':
    'Off by default. Current images remain protected; independent admission limits still apply.',
  strategy: 'History selection',
  'strategy-count': 'Newest images by count',
  'strategy-memory': 'Decoded file bytes',
  count: 'Image count',
  'count-help':
    '0 removes the history count limit. Current images use these slots; if they exceed the count, all current images stay and older images are omitted.',
  remote: 'Include remote images in the count',
  'remote-help':
    'Off keeps remote URLs without using inline-image slots. On counts older remote images alongside inline images; current images stay protected.',
  memory: 'Decoded image budget (MiB)',
  'memory-help':
    'Keep the newest history suffix by exact decoded file bytes. Current images over this budget are rejected. Remote URLs stay because their file size is unknown; they are not downloaded to measure it.',
  'admission-help':
    'Independent admission: 16 inline images, 20 MiB per image and 32 MiB decoded total. A send-window setting does not relax these limits or measure pixel memory.',
  'retention-help':
    'Responses originals use private storage: 20 MiB per item, 512 MiB total, 48-hour expiry refreshed on access. Lost or expired originals must be resent; changing the window cannot recreate them.',
  save: 'Save image window',
  saving: 'Saving…',
  saved: 'Image window saved and applied.',
  pending: 'Image window saved. Restart the selected core to apply it.',
  failed: 'Image window could not be saved. Your edits remain; try saving again.',
  'invalid-count': 'Enter a whole image count from 0 to 256.',
  'invalid-memory': 'Enter a whole decoded-file budget from 1 to 512 MiB.',
  unavailable:
    'The selected settings owner is unavailable. Retry the service connection before saving.',
};

export const imageSendWindowChinese: typeof imageSendWindowEnglish = {
  title: '发送给模型的历史图片',
  description: '选择每次请求携带的历史图片。发送时省略图片，不会删除仍在保留期内的原件。',
  enabled: '限制历史图片',
  'enabled-help': '默认关闭。当前图片受保护，独立的安全准入限制始终有效。',
  strategy: '历史选择策略',
  'strategy-count': '按张数保留最新图片',
  'strategy-memory': '按解码后文件字节选择',
  count: '图片张数',
  'count-help':
    '0 表示不限制历史张数。当前图片占用名额；当前图片超过设定张数时全部保留，并省略旧图片。',
  remote: '将远程图片纳入张数',
  'remote-help':
    '关闭时保留远程 URL，不占内联图片名额。开启时，历史远程图片与内联图片一起计数；当前图片仍受保护。',
  memory: '解码后图片预算（MiB）',
  'memory-help':
    '按精确解码文件字节保留最新的连续历史。当前图片超过预算会被拒绝。远程 URL 的文件大小未知，因此保留，也不会为测量而下载。',
  'admission-help':
    '独立准入限制：16 张内联图片、单张 20 MiB、解码后总计 32 MiB。发送窗口不会放宽这些限制，也不代表像素展开内存。',
  'retention-help':
    'Responses 原件使用私有存储：单项 20 MiB、总计 512 MiB，48 小时到期，访问会刷新期限。丢失或过期后需重新发送；调整窗口无法重建原图。',
  save: '保存图片窗口',
  saving: '正在保存…',
  saved: '图片窗口已保存并生效。',
  pending: '图片窗口已保存，需重启所选核心后生效。',
  failed: '图片窗口保存失败，修改仍保留，请重试保存。',
  'invalid-count': '请输入 0 至 256 的整数张数。',
  'invalid-memory': '请输入 1 至 512 MiB 的整数文件字节预算。',
  unavailable: '所选设置服务不可用，请恢复服务连接后再保存。',
};
