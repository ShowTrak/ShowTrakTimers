const Schema = [];

Schema.push({
	Name: "Timers",
	SQL: "CREATE TABLE IF NOT EXISTS `Timers` ( \
            ID INTEGER PRIMARY KEY AUTOINCREMENT, \
            Type TEXT, \
            Name TEXT, \
            Description TEXT, \
            Duration INTEGER, \
            Weight INTEGER NOT NULL DEFAULT 100, \
            TextAlert BOOLEAN, \
            AudioAlert BOOLEAN, \
            ShowOnWeb BOOLEAN NOT NULL DEFAULT 1 \
    )",
});

Schema.push({
	Name: "Settings",
	SQL: "CREATE TABLE IF NOT EXISTS `Settings` ( \
            Key TEXT PRIMARY KEY, \
            Value BLOB \
    )",
});

module.exports = Schema;
