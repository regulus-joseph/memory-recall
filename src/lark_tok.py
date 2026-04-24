"""
jieba-based Chinese word segmentation.
内置词典覆盖常用词，用户词典（user_dict.txt）存储 LLM 发现的新词。
"""
import os

_USER_DICT = os.path.join(os.path.dirname(__file__), "user_dict.txt")

STOPWORDS = {
    "的", "了", "是", "在", "和", "有", "我", "你", "他", "她", "它",
    "这", "那", "个", "吗", "呢", "吧", "啊", "哦", "嗯", "就", "也",
    "都", "很", "要", "会", "能", "不", "没", "又", "更", "最",
    "一个", "什么", "怎么", "为什么", "因为", "所以", "但是", "如果", "虽然",
    "这个", "那个", "已经", "正在", "将要", "应该", "可能", "必须",
    "做", "去", "来", "到", "给", "把", "被", "让", "请", "跟", "说",
    "自己", "别人", "大家", "我们", "你们", "他们",
    "一些", "一点", "比较", "非常", "特别", "真的", "其实",
    "里", "中", "上", "下", "前", "后", "内", "外", "间",
}


def _init_jieba():
    import jieba
    jieba.initialize()
    if os.path.exists(_USER_DICT):
        jieba.load_userdict(_USER_DICT)


_tokenize_fn = None


def _get_tokenize():
    global _tokenize_fn
    if _tokenize_fn is None:
        _init_jieba()
        import jieba as _jieba_mod
        def _tokenize(text: str) -> list[str]:
            words = list(_jieba_mod.cut(text))
            return [w for w in words if w not in STOPWORDS and len(w) > 1]
        _tokenize_fn = _tokenize
    return _tokenize_fn


def tokenize(text: str) -> list[str]:
    return _get_tokenize()(text)


def add_word(word: str):
    import jieba
    jieba.add_word(word)


def get_user_dict_path() -> str:
    return _USER_DICT


if __name__ == "__main__":
    tests = [
        "我爱跑步和游泳",
        "我住在深圳南山区，喜欢喝铁观音",
        "我下周要去上海出差三天",
        "我每周读一本书",
        "我每天都练习冥想",
        "我爱收集黑胶唱片",
        "我爱下围棋和打桥牌",
        "我今天买了新键盘，是红轴的",
        "测试一下",
        "麻辣火锅",
        "我要去德国柏林出差",
    ]
    for t in tests:
        print(f"'{t}' -> {tokenize(t)}")
