export const LANXI_ONBOARDING_GUIDE = {
  version: "1",
  icon: "🌌",
  title: "欢迎使用蓝汐——认知图谱长期记忆",
  subtitle: "1 分钟了解潮汐星海、五层 Markdown 记忆流、锚点目标与潮汐维护（随时点顶栏「? 指南」重看）",
  steps: [
    {
      icon: "✦",
      navTitle: "潮汐星海图谱",
      title: "在交互式星海里直观看见全部长期记忆",
      desc: "蓝汐把所有长期记忆按重要度与活跃度排布在 5 条轨道上：越靠近中心越核心、越长久。",
      spotlight: {
        clickBefore: '.seg-btn[data-view="starfield"]',
        selector: "#star-canvas",
        buttonText: "定位星海画布",
        hint: "支持滚轮缩放、拖拽平移、点击任意节点查看详情与关联连线，顶部可按轨道筛选"
      },
      items: [
        {
          icon: "🪐",
          title: "五层纯 Markdown 真源",
          text: "anchor 锚点、self 自我、structural 架构、knowledge 知识、episodic 情景全部以可读 Markdown 存于本机。"
        },
        {
          icon: "🔗",
          title: "节点连线与快速搜索",
          text: "可手动建立节点间因果/依赖连线，右侧实时支持中文 CJK FTS5 全文瞬时检索。"
        }
      ],
      tip: "重要度 ≥ 0.7 的节点会自动启用硬保护，不会被潮汐衰减误归档。"
    },
    {
      icon: "≋",
      navTitle: "记忆流与筛选",
      title: "按层级、排序与关键词浏览与整理记忆",
      desc: "想逐条翻阅、编辑、调整重要度或批量归档旧情景记忆？切到「记忆流」最顺手。",
      spotlight: {
        clickBefore: '.seg-btn[data-view="stream"]',
        selector: "#layer-pills",
        buttonText: "定位层级筛选",
        hint: "点上方层级胶囊即可按 anchor / structural / knowledge / episodic / 已归档 快速过滤"
      },
      items: [
        {
          icon: "🔎",
          title: "全文搜索 + 多维排序",
          text: "支持按最近访问、重要度、潮汐强度或创建时间排序，精准定位需要修订的条目。"
        },
        {
          icon: "📦",
          title: "一键调权与安全归档",
          text: "支持单条或批量归档、从归档恢复，随时可打开原文微调标题与正文。"
        }
      ],
      tip: "每次在对话里召回某条记忆，它的访问强化分都会自动提升，越常用的记忆越稳固。"
    },
    {
      icon: "◈",
      navTitle: "锚点与长期目标",
      title: "把长期约定与持续推进的目标固定下来",
      desc: "「锚点与目标」专门集中展示最高优先级的长期目标、待决疑点与硬保护规范。",
      spotlight: {
        clickBefore: '.seg-btn[data-view="anchors"]',
        selector: "#goals-list",
        buttonText: "定位长期目标",
        hint: "跨会话推进的长期项目目标与核心硬规则都在这里置顶呈现"
      },
      items: [
        {
          icon: "🎯",
          title: "跨会话目标追踪",
          text: "记录长期目标与进展状态，换新对话后也能立刻接上上次做到哪一步。"
        },
        {
          icon: "⚓",
          title: "硬保护核心规范",
          text: "核心偏好与架构铁律挂成锚点后，AI 在规划和改动前能第一时间召回遵循。"
        }
      ],
      tip: "对话里直接说「帮我用蓝汐记住这条规范」就会自动写入对应层级。"
    },
    {
      icon: "⚙",
      navTitle: "潮汐维护与 AI 整理",
      title: "定期潮汐衰减、AI 语义归并与外部导入",
      desc: "在「潮汐维护」可一键执行遗忘曲线维护、用外部模型智能整合零散情景笔记，或导入 Obsidian / Markdown 笔记库。",
      spotlight: {
        clickBefore: '.seg-btn[data-view="maintain"]',
        selector: "#view-maintain",
        buttonText: "定位潮汐维护",
        hint: "角标提示待维护数量；可按需配置语义检索模型、AI 归并整理与笔记库导入"
      },
      items: [
        {
          icon: "🌊",
          title: "自然遗忘，越用越清晰",
          text: "长期不再触碰的低权重零碎记录会随时间自然退潮归档，保持召回精准不臃肿。"
        },
        {
          icon: "📚",
          title: "兼容导入 Markdown Vault",
          text: "支持把现有 Markdown 文件夹快速导入认知图谱，所有数据 100% 留在本地。"
        }
      ],
      tip: "随时可点顶栏「? 指南」重看本教程；支持键盘 ← / → 翻页与 Esc 关闭。"
    }
  ]
};
