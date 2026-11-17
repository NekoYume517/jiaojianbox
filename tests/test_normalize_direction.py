from collector import normalize


def row(sender="", content="hello", is_send=None):
    item = {
        "sender_username": sender,
        "content": content,
        "create_time": 1763000000,
        "type": "文本",
        "local_id": 1,
        "sort_seq": 1,
        "shard": "",
    }
    if is_send is not None:
        item["is_send"] = is_send
    return item


ACCOUNT = "wxid_stsn25yjix1222_9353"
SELF = "wxid_stsn25yjix1222"
OTHER = "wxid_gt6gd8e1ep9k22"


def test_private_message_from_self_uses_bare_wxid():
    message = normalize.wechat(row(SELF), ACCOUNT, OTHER)
    assert message["from_self"] is True
    assert message["sender_name"] == "我"


def test_private_message_from_other():
    message = normalize.wechat(row(OTHER), ACCOUNT, OTHER, sender_name="战忠沅")
    assert message["from_self"] is False
    assert message["sender_name"] == "战忠沅"


def test_account_suffix_and_group_prefix():
    message = normalize.wechat(row(ACCOUNT), ACCOUNT, "51732847362@chatroom")
    assert message["from_self"] is True
    message = normalize.wechat(row("", content=SELF + ":\n在吗"), ACCOUNT, "51732847362@chatroom")
    assert message["from_self"] is True
    assert message["text"] == "在吗"


def test_wcdb_is_send_flag_wins():
    message = normalize.wechat(row("", is_send=1), ACCOUNT, OTHER)
    assert message["from_self"] is True
    message = normalize.wechat(row(OTHER, is_send=0), ACCOUNT, OTHER)
    assert message["from_self"] is False
