screen main_menu():
    tag menu
    add "harbor.png"
    vbox:
        xpos 82
        ypos 70
        spacing 14
        text "末班渡船" size 64 color "#fff3d6"
        text "LAST FERRY" size 20 color "#e4d0ad"
        null height 14
        textbutton "上船" action Start() text_size 31 text_idle_color "#ffebbf" text_hover_color "#ffffff"
        textbutton "离开" action Quit(confirm=False) text_size 23 text_idle_color "#ced8d7" text_hover_color "#ffffff"

screen say(who, what):
    window:
        id "window"
        xfill True
        yalign 1.0
        ysize 174
        padding (84, 22)
        background Solid("#152431ed")
        vbox:
            spacing 9
            if who:
                text who id "who" size 25 color "#efd6ae"
            text what id "what" size 29 color "#faf7eb" line_spacing 4

screen choice(items):
    vbox:
        xalign 0.5
        yalign 0.59
        spacing 14
        for item in items:
            textbutton item.caption:
                xsize 430
                padding (24, 15)
                background Solid("#192f3eec")
                hover_background Solid("#435a65")
                text_xalign 0.5
                text_size 29
                text_color "#fff0cc"
                action item.action

# Ren'Py's bare-project loader uses a label to enter a custom main menu.
label main_menu:
    call screen main_menu
    return
