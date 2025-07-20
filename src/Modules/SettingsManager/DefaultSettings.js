const DefaultSettings = [
    {
        Group: "UI",
        Key: "UI_DISPLAY_TIMERS_IN_TABLE",
        Title: "List View",
        Description: "Displays timers in a table instead of a grid.",
        Type: "BOOLEAN",
        DefaultValue: false,
    },

    {
        Group: "System",
        Key: "SYSTEM_PREVENT_DISPLAY_SLEEP",
        Title: "Prevent Display Sleep",
        Description: "Prevents the display from going to sleep while ShowTrak is running.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
    {
        Group: "System",
        Key: "SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4",
        Title: "Stop Accidental Shutdowns (Reboot Required)",
        Description: "Requires confirmation before shutting down ShowTrak when pressing Alt+F4.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
    {
        Group: "System",
        Key: "SYSTEM_AUTO_UPDATE",
        Title: "Automatic Updates (Reboot Required)",
        Description: "Automatically update ShowTrak to the latest stable version.",
        Type: "BOOLEAN",
        DefaultValue: true,
    },
];

const Groups = [
    { Name: "UI", Title: "UI" },
    { Name: "System", Title: "System Settings" },
]

module.exports = {
    DefaultSettings, 
    Groups
};