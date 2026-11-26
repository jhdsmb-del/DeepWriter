# 末班渡船 · A short original story for DeepWriter
define config.name = "末班渡船"
define config.version = "1.0"
define config.window_title = "末班渡船 · DeepWriter"
define config.save_directory = "deepwriter-last-ferry"
define config.screen_width = 1280
define config.screen_height = 720
style default:
    font "FerryText.ttf"
    language "unicode"
define keeper = Character("检票员", color="#ecd5ac")
define painter = Character("油漆工", color="#b2d6d6")
image ferry_dock = "harbor.png"

label start:
    scene ferry_dock with fade
    "末班船解缆前，油漆工跑来，把一张五毛钱的旧渡票拍在窗口。"
    keeper "这票比我上班的年头还长。"
    painter "不是要坐船。你听。"
    "对岸响了两短一长。检票员手边的铜铃也有三道磨痕。再过一夜，这个窗口就要拆了。"
    menu:
        "敲铃应他":
            jump bells
        "把票送过河":
            jump ticket

label bells:
    scene ferry_dock
    "检票员第一次没照时刻表敲铃。两短，一长。隔着水，第三声碰到了第三声。"
    "油漆工把旧票翻过来，背面是一张画歪的船，窗里坐着两个扎辫子的小孩。"
    painter "我姐画的。她还记得。"
    "渡船在两岸的铃声中空船离开。检票员用铅笔，在最后一行旅客人数里填了个规规矩矩的零。"
    return

label ticket:
    scene ferry_dock
    "检票员把票夹进票钳，咔哒。最后一个月牙孔，正好落在票角那轮手画的月亮上。"
    "对岸有人接过船工递来的票，举到灯前。月牙透着光。"
    painter "她看得见了。"
    "油漆工付了五毛钱。检票员把硬币按进收银盘。今天最后一笔账，倒和三十年前一样平。"
    return
