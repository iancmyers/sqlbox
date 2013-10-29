function createPeopleTable(mysql, callback) {
  mysql.query('CREATE TABLE IF NOT EXISTS sqlbox_test_people (' +
    'id SERIAL PRIMARY KEY,' +
    'name VARCHAR(255) UNIQUE,' +
    'age INTEGER,' +
    'account_id INTEGER,' +
    'hashed_password TEXT,' +
    'created_at TIMESTAMP DEFAULT current_timestamp,' +
    'updated_at TIMESTAMP DEFAULT current_timestamp,' +
    'revision INTEGER DEFAULT 1' +
  ');', callback);
}

function dropPeopleTable(mysql, callback) {
  mysql.query('DROP TABLE IF EXISTS sqlbox_test_people;', callback);
}


exports.createPeopleTable = createPeopleTable;
exports.dropPeopleTable = dropPeopleTable;
